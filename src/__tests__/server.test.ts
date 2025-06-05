import type { Server } from 'node:http';
import request from 'supertest';
import { startServer } from '../server';
import { AxidrawFast, plan } from '../planning';

jest.mock("../serialport-serialport");

// Mock the server module to ensure EBB is always connected in tests
jest.mock("../server", () => {
  const originalModule = jest.requireActual("../server");
  return {
    ...originalModule,
    waitForEbb: jest.fn().mockResolvedValue('/dev/ttyMOCK'),
  };
});

// Global reference to track the mock EBB instance
let mockEbbInstance: any = null;

jest.mock("../ebb", () => {
  const actualEbb = jest.requireActual('../ebb');
  
  return {
    ...actualEbb,
    EBB: class MockEBB extends actualEbb.EBB {
      public commands: string[] = [];
      public slowMode = false;
      public commandCount = 0;
      
      constructor(port: any, hardware: any = 'v3') {
        let responseController: ReadableStreamDefaultController | null = null;
        
        // Create a writable stream that captures commands and generates responses
        const writableStream = new WritableStream({
          write: async (chunk) => {
            const command = new TextDecoder().decode(chunk);
            const trimmedCommand = command.trim();
            
            if (mockEbbInstance && trimmedCommand) {
              mockEbbInstance.commandCount++;
              mockEbbInstance.commands.push(trimmedCommand);
              // console.log(`EBB Command #${mockEbbInstance.commandCount}: ${trimmedCommand}`);
              
              // Simulate delay if in slow mode
              if (mockEbbInstance.slowMode) {
                await new Promise(resolve => setTimeout(resolve, 5));
              }
              
              // Generate response with small delay to simulate hardware
              setTimeout(() => {
                if (responseController) {
                  const response = mockEbbInstance.getResponseForCommand(trimmedCommand);
                  // console.log(`EBB Response #${mockEbbInstance.commandCount}: ${response.trim()}`);
                  
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
            console.log('Mock EBB readable stream ready for TextDecoderStream');
          }
        });
        
        // Create the mock port
        const mockPort = {
          writable: writableStream,
          readable: readableStream,
          close: async () => {
            if (mockEbbInstance) {
              mockEbbInstance.commands.push('port.close()');
            }
            if (responseController) {
              try {
                responseController.close();
              } catch (e) {
                console.log('Error closing response controller:', e);
              }
            }
          },
          addEventListener: () => {},
        };
        
        super(mockPort, hardware);
        mockEbbInstance = this;
        console.log('MockEBB constructed for TextDecoderStream pipeline');
      }
      
      // Generate appropriate responses based on command type
      getResponseForCommand(command: string): string {
        if (command.startsWith('QM')) {
          // QM returns: GlobalStatus,CommandStatus,Motor1Status,Motor2Status,FIFOStatus
          // The waitUntilMotorsIdle() checks commandStatus[1] === "0" and fifoStatus[4] === "0"
          // Return "1,0,0,0,0" meaning: Global=1, Command=0(idle), M1=0, M2=0, FIFO=0(empty)
          return '1,0,0,0,0\r\n';
        }if (command.startsWith('QB')) {
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

      }
      
      clearCommands(): void {
        this.commands = [];
        this.commandCount = 0;
      }
      
      getCommandSummary(): string {
        return `Total commands: ${this.commandCount}\nCommands: ${this.commands.join(', ')}`;
      }
    }
  };
});


// Test data constants
const SIMPLE_PATHS = [
  [{x: 10, y: 10}, {x: 20, y: 10}],
  [{x: 10, y: 20}, {x: 20, y: 20}]
];

const COMPLEX_PATHS = [
  [{x: 0, y: 0}, {x: 100, y: 0}],
  [{x: 0, y: 50}, {x: 100, y: 50}],
  [{x: 0, y: 100}, {x: 100, y: 100}],
  [{x: 0, y: 150}, {x: 100, y: 150}]
];

const PAUSE_PATHS = [
  [{x: 0, y: 0}, {x: 100, y: 0}],
  [{x: 0, y: 50}, {x: 100, y: 50}],
  [{x: 0, y: 100}, {x: 100, y: 100}],
  [{x: 0, y: 200}, {x: 200, y: 200}],
];

const STATUS_PATHS = [
  [{x: 0, y: 0}, {x: 100, y: 0}],
  [{x: 0, y: 50}, {x: 100, y: 50}]
];

// Helper function to create valid plan
function createValidPlan(paths: Array<Array<{x: number, y: number}>>) {
  const validPlan = plan(paths, AxidrawFast);
  return validPlan.serialize();
}

// Pre-serialized plan constants
const SIMPLE_PLAN = createValidPlan(SIMPLE_PATHS);
const COMPLEX_PLAN = createValidPlan(COMPLEX_PATHS);
const PAUSE_PLAN = createValidPlan(PAUSE_PATHS);
const STATUS_PLAN = createValidPlan(STATUS_PATHS);

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
    if (mockEbbInstance) {
      mockEbbInstance.commands = [];
      mockEbbInstance.slowMode = false;
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
 
    // Check the commands that were sent to the mock EBB
    expect(mockEbbInstance.commands.length).toBeGreaterThan(0);
    expect(mockEbbInstance.commands).toContain('EM,1,1');
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
    expect(mockEbbInstance.commands).toContain('EM,1,1');
    // Should have executed the postCancel sequence
    expect(mockEbbInstance.commands).toContain('HM,4000');
  }, 15000);

  test('should accept pause request and pause plotting', async () => {
    // Start the plot
    await request(server)
      .post('/plot')
      .send(PAUSE_PLAN)
      .expect(200);

    // Send pause command
    await request(server)
      .post('/pause')
      .expect(200);

    // Check that some commands were logged before pause
    expect(mockEbbInstance.commands).toContain('EM,1,1');
    // should NOT have the final motor disable command
    expect(mockEbbInstance.commands).not.toContain('SR,60000000,0')
  }, 10000);

  test('should accept resume request and continue plotting', async () => {
    // Start plot
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
    expect(mockEbbInstance.commands.length).toBeGreaterThan(0);
    expect(mockEbbInstance.commands).toContain('EM,1,1');
    // Should have completed with motor disable (plot continued after resume)
    expect(mockEbbInstance.commands).toContain('SR,60000000,0');
  }, 10000);

  test('should get plot status correctly', async () => {
    // Check initial status (should not be plotting)
    let statusResponse = await request(server)
      .get('/plot/status')
      .expect(200);
    expect(statusResponse.body.plotting).toBe(false);

    await request(server)
      .post('/plot')
      .send(STATUS_PLAN)
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
