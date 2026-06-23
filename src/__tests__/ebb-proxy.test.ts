import { describe, expect, test, vi } from "vitest";
import { createEbbProxy } from "../ebb-proxy";
import { createMockSerialPort, mockSerialPortInstance } from "./mocks/serialport";

// Under vitest, createEbbProxy runs the worker host in-process, so this mock
// (and its shared command log) apply to the EBB the host opens.
vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    return createMockSerialPort();
  }),
}));

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

describe("EbbProxy <-> worker host RPC", () => {
  test("connects, forwards commands, returns query results, and cancels", async () => {
    mockSerialPortInstance.clearCommands();
    const proxy = await createEbbProxy({ com: "/dev/ttyMOCK", hardware: "v3" });

    // The host's reconnect loop opens the (mock) port and reports the device up.
    await waitFor(() => proxy.connected);
    expect(proxy.devicePath).toBe(null); // the mock has no real path

    // A command RPC round-trips and is written to the port.
    await proxy.enableMotors(1);
    expect(mockSerialPortInstance.commands).toContain("EM,1,1");

    // A query RPC returns a value. The mock reports firmware 2.5.3 (< 2.6.0).
    await expect(proxy.supportsSR()).resolves.toBe(false);

    // Method args are forwarded in order: S2,<height>,<pin>,<rate>,<delay>.
    await proxy.setPenHeight(1000, 500);
    expect(mockSerialPortInstance.commands.some((c) => c.startsWith("S2,1000,4,500"))).toBe(true);

    // Cancel is delivered out-of-band and does not throw.
    expect(() => proxy.cancel()).not.toThrow();

    await proxy.terminate();
  });
});
