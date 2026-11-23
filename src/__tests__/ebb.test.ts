import { beforeEach, describe, expect, it, vi } from "vitest";
import { EBB } from "../ebb.js";
import { PenMotion } from "../planning.js";
import { SerialPortSerialPort } from "../serialport-serialport.js";
import { createMockSerialPort, mockSerialPortInstance } from "./mocks/serialport.js";

vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    return createMockSerialPort();
  }),
}));

describe("EBB", () => {
  beforeEach(() => {
    mockSerialPortInstance.clearCommands();
  });

  it("firmware version", async () => {
    const port = new SerialPortSerialPort("/dev/ebb");
    await port.open({ baudRate: 9600 });
    const ebb = await EBB.create(port);

    const version = ebb.firmwareVersion;
    expect(version).toEqual([2, 5, 3]);
    expect(mockSerialPortInstance.commands).toContain("V");
  });

  it("enable motors", async () => {
    const port = new SerialPortSerialPort("/dev/ebb");
    await port.open({ baudRate: 9600 });
    const ebb = await EBB.create(port);

    await ebb.enableMotors(2);
    expect(mockSerialPortInstance.commands).toContain("EM,2,2");
    expect(mockSerialPortInstance.commands).toContain("V"); // Version check for supportsSR()
  });

  it("executePenMotion rounds S2 duration and rate to integers", async () => {
    const port = new SerialPortSerialPort("/dev/ebb");
    await port.open({ baudRate: 9600 });
    const ebb = await EBB.create(port, "brushless");

    // 0.07 * 1000 === 70.00000000000001 in IEEE-754 floating-point
    await ebb.executePenMotion(new PenMotion(8280, 11808, 0.07));
    expect(mockSerialPortInstance.commands).toContain("S2,11808,5,1210,70");
  });
});
