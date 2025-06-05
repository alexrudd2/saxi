import type { Server } from 'node:http';
import request from 'supertest';
import { startServer } from '../server';
import { AxidrawFast, plan } from '../planning';

// Global reference to track the mock serial port instance
const mockSerialPortInstance: any = {
  commands: [],
  slowMode: false,
  commandCount: 0,
  
  // Generate appropriate responses based on command type
  getResponseForCommand(command: string): string {
    if (command.startsWith('QM')) {
      // QM returns: GlobalStatus,CommandStatus,Motor1Status,Motor2Status,FIFOStatus
      // The waitUntilMotorsIdle() checks commandStatus[1] === "0" and fifoStatus[4] === "0"
      // Return "1,0,0,0,0" meaning: Global=1, Command=0(idle), M1=0, M2=0, FIFO=0(empty)
      return '1,0,0,0,0\r\n';
    } if (command.startsWith('QB')) {
      // Query button - return not pressed
      return '0\r\n';
    } if (command.startsWith('QP')) {
      // Query pen status - return pen up (1) or down (0)
      return '1\r\n';
    } if (command.startsWith('V') || command.startsWith('v')) {
      // Version query
      return 'EBBv13_and_above\r\n';
    } if (command.startsWith('QE')) {
      // Query encoder - return 0,0 for no movement
      return '0,0\r\n';
    } if (command.startsWith('QS')) {
      // Query step position - return current step positions
      return '0,0\r\n';
    } if (command.startsWith('ST')) {
      // Stepper and servo mode query
      return '1\r\n';
    }
    // Default OK response for most commands (SM, XM, LM, EM, etc.)
    return 'OK\r\n';
  },
  
  clearCommands(): void {
    this.commands = [];
    this.commandCount = 0;
  },
  
  getCommandSummary(): string {
    return `Total commands: ${this.commandCount}\nCommands: ${this.commands.join(', ')}`;
  }
};

// Mock the serialport module to capture commands and generate responses
jest.mock("../serialport-serialport", () => {
  return {
    SerialPortSerialPort: jest.fn().mockImplementation((path: string) => {
      let responseController: ReadableStreamDefaultController | null = null;
      
      // Create a writable stream that captures commands and generates responses
      const writableStream = new WritableStream({
        write: async (chunk) => {
          const command = new TextDecoder().decode(chunk);
          const trimmedCommand = command.trim();
          
          if (mockSerialPortInstance && trimmedCommand) {
            mockSerialPortInstance.commandCount++;
            mockSerialPortInstance.commands.push(trimmedCommand);
            // console.log(`Serial Command #${mockSerialPortInstance.commandCount}: ${trimmedCommand}`);
            
            // Simulate delay if in slow mode
            if (mockSerialPortInstance.slowMode) {
              await new Promise(resolve => setTimeout(resolve, 5));
            }
            
            // Generate response with small delay to simulate hardware
            setTimeout(() => {
              if (responseController) {
                const response = mockSerialPortInstance.getResponseForCommand(trimmedCommand);
                // console.log(`Serial Response #${mockSerialPortInstance.commandCount}: ${response.trim()}`);
                
                // Ensure response has proper line ending for TextDecoderStream parsing
                const responseWithNewline = response.endsWith('\r\n') ? response : `${response}\r\n`;
                
                // Send as bytes since TextDecoderStream will decode it
                responseController.enqueue(new TextEncoder().encode(responseWithNewline));
              }
            }, 10);
          }
        }
      });
      
      // Create a readable stream that the TextDecoderStream can process
      const readableStream = new ReadableStream({
        start(controller) {
          responseController = controller;
          console.log('Mock SerialPort readable stream ready for TextDecoderStream');
        }
      });
      
      // Return mock SerialPort instance
      return {
        readable: readableStream,
        writable: writableStream,
        connected: false,
        
        open: jest.fn().mockImplementation((options: any) => {
          console.log('Mock SerialPort.open() called with options:', options);
          return Promise.resolve();
        }),
        
        close: jest.fn().mockImplementation(() => {
          if (mockSerialPortInstance) {
            mockSerialPortInstance.commands.push('port.close()');
          }
          if (responseController) {
            try {
              responseController.close();
            } catch (e) {
              console.log('Error closing response controller:', e);
            }
          }
          return Promise.resolve();
        }),
        
        setSignals: jest.fn().mockResolvedValue(undefined),
        getSignals: jest.fn().mockResolvedValue({}),
        getInfo: jest.fn().mockReturnValue({}),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
        forget: jest.fn().mockResolvedValue(undefined)
      };
    })
  };
});

// Mock the server module to ensure EBB is always connected in tests
jest.mock("../server", () => {
  const originalModule = jest.requireActual("../server");
  return {
    ...originalModule,
    waitForEbb: jest.fn().mockResolvedValue('/dev/ttyMOCK'),
  };
});


// Test data constants
const SIMPLE_PATHS = [
  [{x: 10, y: 10}, {x: 20, y: 10}],
];

const COMPLEX_PATHS = [
  [{x: 0, y: 0}, {x: 100, y: 0}],
  [{x: 0, y: 50}, {x: 100, y: 50}],
  [{x: 0, y: 100}, {x: 100, y: 100}],
  [{x: 0, y: 150}, {x: 100, y: 150}],
];

// Helper function to create valid plan
function createValidPlan(paths: Array<Array<{x: number, y: number}>>) {
  const validPlan = plan(paths, AxidrawFast);
  return validPlan.serialize();
}

// Pre-serialized plan constants
const SIMPLE_PLAN = createValidPlan(SIMPLE_PATHS);
const COMPLEX_PLAN = createValidPlan(COMPLEX_PATHS);

// Helper function to wait for plotting to complete
async function waitForPlottingComplete(server: Server, timeout = 10000): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const statusResponse = await request(server).get('/plot/status');
    if (!statusResponse.body.plotting) {
      return; // Plotting complete
    }
    
    // Wait 100ms before checking again
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  throw new Error(`Plotting did not complete within ${timeout}ms`);
}

describe('Plot Endpoint Test', () => {
  let server: Server;

  // Set up server before each test
  beforeEach(async () => {
    // Clean up mock state
    if (mockSerialPortInstance) {
      mockSerialPortInstance.commands = [];
      mockSerialPortInstance.slowMode = false;
    }
    
    // Create fresh server instance
    server = await startServer(0); // Use port 0 for dynamic port assignment
  });

  // Clean up server after each test
  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  test('should accept a valid plot plan and log EBB commands', async () => {
    await request(server)
      .post('/plot')
      .send(SIMPLE_PLAN)
      .expect(200);
 
    // Check the commands that were sent to the mock serial port
    expect(mockSerialPortInstance.commands.length).toBeGreaterThan(0);
    expect(mockSerialPortInstance.commands).toContain('EM,1,1');
  });

  test('should reject plot when another plot is in progress', async () => {
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
  });

  test('should handle malformed plan data', async () => {
    const invalidPlan = {
      notMotions: "invalid"
    };

    await request(server)
      .post('/plot')
      .send(invalidPlan)
      .expect(500);
  });

  test('should handle empty request body', async () => {
    await request(server)
      .post('/plot')
      .send({})
      .expect(500);
  });

  test('should accept cancel request and stop plotting', async () => {
    // Start plot
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

    // Verify cancellation behavior
    expect(mockSerialPortInstance.commands).toContain('EM,1,1');
    // Should have executed the postCancel sequence
    expect(mockSerialPortInstance.commands).toContain('HM,4000');
  }, 15000);

  test('should accept pause request and pause plotting', async () => {
    mockSerialPortInstance.slowMode = true;
    // Start the plot
    await request(server)
      .post('/plot')
      .send(COMPLEX_PLAN)
      .expect(200);

    // Send pause command
    await request(server)
      .post('/pause')
      .expect(200);

    // Check that some commands were logged before pause
    expect(mockSerialPortInstance.commands).toContain('EM,1,1');
    // should NOT have the final motor disable command
    expect(mockSerialPortInstance.commands).not.toContain('SR,60000000,0')
  }, 10000);

  test('should accept resume request and continue plotting', async () => {
    
    mockSerialPortInstance.slowMode = true;
    await request(server)
      .post('/plot')  
      .send(SIMPLE_PLAN)
      .expect(200);

    await request(server)
      .post('/pause')
      .expect(200);

    await request(server)
      .post('/resume')
      .expect(200);

    // Wait for plot to complete
    await waitForPlottingComplete(server);

    // Verify commands were still executed
    expect(mockSerialPortInstance.commands.length).toBeGreaterThan(0);
    expect(mockSerialPortInstance.commands).toContain('EM,1,1');
    // Should have completed with motor disable (plot continued after resume)
    expect(mockSerialPortInstance.commands).toContain('SR,60000000,0');
  }, 10000);

  test('should get plot status correctly', async () => {
    // Check initial status (should not be plotting)
    let statusResponse = await request(server)
      .get('/plot/status')
      .expect(200);
    expect(statusResponse.body.plotting).toBe(false);

    await request(server)
      .post('/plot')
      .send(COMPLEX_PLAN)
      .expect(200);

    // Check status while plotting
    statusResponse = await request(server)
      .get('/plot/status')
      .expect(200);
    expect(statusResponse.body.plotting).toBe(true);

    // Wait for plot to complete
    await waitForPlottingComplete(server);

    // Check final status
    statusResponse = await request(server)
      .get('/plot/status')
      .expect(200);
    expect(statusResponse.body.plotting).toBe(false);
  }, 10000);
});
