import { vi } from 'vitest';
import { mockSerialPortInstance, createMockSerialPort } from './mocks/serialport';
import { EBB } from "../ebb";

vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn().mockImplementation(createMockSerialPort)
}));

const { SerialPortSerialPort } = await import("../serialport-serialport");

describe("EBB", () => {
  beforeEach(() => {
    mockSerialPortInstance.clearCommands();
  });

  it("firmware version", async () => {
    const port = new SerialPortSerialPort('/dev/ebb');
    await port.open({ baudRate: 9600 });
    const ebb = new EBB(port);
    
    const version = await ebb.firmwareVersion();
    expect(version).toEqual('test 2.5.3');
    expect(mockSerialPortInstance.commands).toContain('V');
  })

  it("enable motors", async () => {
    const port = new SerialPortSerialPort('/dev/ebb');
    await port.open({ baudRate: 9600 });
    const ebb = new EBB(port);
    
    await ebb.enableMotors(2);
    expect(mockSerialPortInstance.commands).toContain('EM,2,2');
    expect(mockSerialPortInstance.commands).toContain('V'); // Version check for supportsSR()
  })
})
