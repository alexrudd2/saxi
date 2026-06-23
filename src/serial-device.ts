/**
 * Serial device discovery and connection helpers for the EBB.
 *
 * Extracted from server.ts so the serial worker (ebb-worker.ts) can own port
 * lifecycle without importing express/ws. The CLI and the worker both use
 * these; the web server reaches the EBB through ebb-proxy.ts instead.
 */
import { autoDetect } from "@serialport/bindings-cpp";
import type { PortInfo } from "@serialport/bindings-interface";
import { EBB, type Hardware } from "./ebb.js";
import { SerialPortSerialPort } from "./serialport-serialport.js";
import * as _self from "./serial-device.js"; // self-import for test mocking

export type Com = string;

export async function tryOpen(com: Com) {
  const port = new SerialPortSerialPort(com);
  await port.open({ baudRate: 9600 });
  return port;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEBB(p: PortInfo): boolean {
  return (
    p.manufacturer === "SchmalzHaus" ||
    p.manufacturer === "SchmalzHaus LLC" ||
    (p.vendorId === "04D8" && p.productId === "FD92")
  );
}

export async function listEBBs() {
  const Binding = autoDetect();
  const ports = await Binding.list();
  return ports.filter(isEBB).map((p: { path: string }) => p.path);
}

export async function waitForEbb(): Promise<Com> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ebbs = await listEBBs();
    if (ebbs.length) {
      return ebbs[0];
    }
    await sleep(5000);
  }
}

/**
 * Async generator over the lifetime of EBB connections: yields a connected EBB,
 * then `null` when it disconnects, then reconnects, forever.
 */
export async function* ebbs(path?: string, hardware: Hardware = "v3") {
  while (true) {
    try {
      const com: Com = path || (await _self.waitForEbb()); // use self-import for test mocking
      console.log(`Found EBB at ${com}`);
      const port = await tryOpen(com);
      const closed = new Promise((resolve) => {
        port.addEventListener("disconnect", resolve, { once: true });
      });
      yield new EBB(port, hardware);
      await closed;
      yield null;
      console.error("Lost connection to EBB, reconnecting...");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`Error connecting to EBB: ${err.message}`);
      console.error("Retrying in 5 seconds...");
      await sleep(5000);
    }
  }
}

export async function connectEBB(hardware: Hardware, device?: string): Promise<EBB | null> {
  const dev = device ?? (await listEBBs())[0];
  if (!dev) return null;

  const port = await tryOpen(dev);
  return new EBB(port, hardware);
}
