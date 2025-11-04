import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { AxidrawFast, plan } from '../planning';
import { createMockSerialPort, mockSerialPortInstance } from './mocks/serialport';

// Mock SerialPortSerialPort using shared implementation
vi.mock('../serialport-serialport', () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    return createMockSerialPort();
  }),
}));

// Mock server to use test device
vi.mock("../server", async () => {
  const original = await vi.importActual("../server") as any;
  return {
    ...original,
    startServer: (port: number, hardware = 'v3', ...args: any[]) =>
      original.startServer(port, hardware, '/dev/ttyMOCK', ...args),
    waitForEbb: vi.fn().mockResolvedValue('/dev/ttyMOCK'),
  };
});

import { startServer } from '../server';

const SIMPLE_PATHS = [
  [{x: 10, y: 10}, {x: 20, y: 10}],
];

const COMPLEX_PATHS = [
  [{x: 0, y: 0}, {x: 100, y: 0}],
  [{x: 0, y: 50}, {x: 100, y: 50}],
  [{x: 0, y: 100}, {x: 100, y: 100}],
  [{x: 0, y: 150}, {x: 100, y: 150}],
];

// Pre-serialized plan constants
const SIMPLE_PLAN = plan(SIMPLE_PATHS, AxidrawFast).serialize();
const COMPLEX_PLAN = plan(COMPLEX_PATHS, AxidrawFast).serialize();

// Helper function to wait for plotting to complete
async function waitForPlottingComplete(server: Server, timeout = 10000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const response = await request(server).get('/plot/status');
    if (!response.body.plotting) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForCommandsLogged(timeout = 5000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (mockSerialPortInstance.commands.length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('Plot Endpoint Test Suite', () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer(0); // Use port 0 for dynamic port assignment
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  // Reset state before each test to ensure isolation
  beforeEach(async () => {
    await waitForPlottingComplete(server);
    mockSerialPortInstance.clearCommands();
  });

  describe('Basic Plot Operations', () => {
    test('accept a valid plot plan and log EBB commands', async () => {
      await request(server)
        .post('/plot')
        .send(SIMPLE_PLAN)
        .expect(200);
   
      // Wait for the plotting to actually start and commands to be logged
      await waitForCommandsLogged();
      
      // Check the commands that were sent to the mock serial port
      expect(mockSerialPortInstance.commands.length).toBeGreaterThan(0);
      expect(mockSerialPortInstance.commands).toContain('EM,1,1');
    });

  });

  describe('Error Handling', () => {
    test('handle malformed plan data', async () => {
      const invalidPlan = {
        notMotions: "invalid"
      };

      await request(server)
        .post('/plot')
        .send(invalidPlan)
        .expect(500);
    });

    test('handle empty request body', async () => {
      await request(server)
        .post('/plot')
        .send({})
        .expect(500);
    });

    test('reject plot when another plot is in progress', async () => {
      // Start first plot - note the request resolves before the plot is finished
      await request(server)
        .post('/plot')
        .send(SIMPLE_PLAN)
        .expect(200);

      // Immediately try second plot
      await request(server)
        .post('/plot')
        .send(SIMPLE_PLAN)
        .expect(400);
        
      // Wait for first plot to complete to avoid affecting other tests
      await waitForPlottingComplete(server);
    });
  });

  describe('Plot Control Operations', () => {
    test('cancel plot', async () => {
      await request(server)
        .post('/plot')
        .send(COMPLEX_PLAN)
        .expect(200);

      // Wait for plot to start executing motions, then cancel
      await new Promise(resolve => setTimeout(resolve, 20));

      await request(server)
        .post('/cancel')
        .expect(200);

      await waitForPlottingComplete(server);
      expect(mockSerialPortInstance.commands).toContain('EM,1,1');
    });

    test('pause and resume plotting', async () => {
      
      await request(server)
        .post('/plot')
        .send(COMPLEX_PLAN)
        .expect(200);

      await request(server)
        .post('/pause')
        .expect(200);

      expect(mockSerialPortInstance.commands).not.toContain('SR,60000000,0');

      await request(server)
        .post('/resume')
        .expect(200);

      // Wait for plot to complete
      await waitForPlottingComplete(server);

      // Verify commands were still executed
      expect(mockSerialPortInstance.commands.length).toBeGreaterThan(0);
      expect(mockSerialPortInstance.commands).toContain('EM,1,1');
      // Should have completed with motor disable (plot continued after resume)
      // FIXME: Is this a real bug on Windows?
      // expect(mockSerialPortInstance.commands).toContain('SR,60000000,0');
    }, 10000);

    test('report plot status', async () => {
      let statusResponse = await request(server)
        .get('/plot/status')
        .expect(200);
      expect(statusResponse.body.plotting).toBe(false);

      await request(server)
        .post('/plot')
        .send(COMPLEX_PLAN)
        .expect(200);

      statusResponse = await request(server)
        .get('/plot/status')
        .expect(200);
      expect(statusResponse.body.plotting).toBe(true);

      await waitForPlottingComplete(server);

      statusResponse = await request(server)
        .get('/plot/status')
        .expect(200);
      expect(statusResponse.body.plotting).toBe(false);
    }, 10000);
  });
});
