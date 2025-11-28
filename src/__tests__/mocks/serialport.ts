import { vi } from "vitest";

// Shared command tracker
export const mockSerialPortInstance = {
  commands: [] as string[],
  commandCount: 0,

  clearCommands(): void {
    this.commands = [];
    this.commandCount = 0;
  },
};

// Shared response logic for EBB commands
const getResponseForCommand = (command: string): string => {
  if (command.startsWith("V") || command.startsWith("v")) return "test 2.5.3\r\n";
  if (command.startsWith("QM")) return "1,0,0,0,0\r\n";
  if (command.startsWith("QB")) return "0\r\n";
  if (command.startsWith("QP")) return "1\r\n";
  if (command.startsWith("QE")) return "0,0\r\n";
  if (command.startsWith("QS")) return "0,0\r\n";
  if (command.startsWith("ST")) return "1\r\n";
  return "OK\r\n";
};

// Shared SerialPortSerialPort mock implementation
export const createMockSerialPort = () => {
  let responseController: ReadableStreamDefaultController | null = null;

  return {
    readable: new ReadableStream({
      start(controller) {
        responseController = controller;
      },
    }),
    writable: new WritableStream({
      write: async (chunk) => {
        const command = new TextDecoder().decode(chunk).trim();
        if (command) {
          mockSerialPortInstance.commandCount++;
          mockSerialPortInstance.commands.push(command);

          // Generate response
          setTimeout(() => {
            if (responseController) {
              const response = getResponseForCommand(command);
              responseController.enqueue(new TextEncoder().encode(response));
            }
          }, 2);
        }
      },
    }),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
  };
};
