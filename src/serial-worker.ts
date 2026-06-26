/**
 * Browser serial worker entry (esbuild entry point -> serial-worker.js).
 *
 * The worker opens the WebSerial port itself (re-acquiring it via
 * navigator.serial.getPorts(), since the main thread already obtained
 * permission with requestPort()) and runs the shared EBB host here. Opening the
 * port in this realm keeps the serial byte pipe on the worker thread — unlike
 * transferring port.readable/writable, which leaves the pipe owned by the main
 * thread and proxies bytes back to it, so main-thread jank starves the board.
 */
import { createEbbHost, type EbbHost } from "./ebb-host.js";
import type { SerialChannel } from "./ebb.js";
import type { HostCommand, HostEvent, InitMsg } from "./serial-worker-rpc.js";

function post(event: HostEvent): void {
  (self as unknown as Worker).postMessage(event);
}

let host: EbbHost | null = null;

/** Find the authorized port matching the device the user picked on the main thread. */
async function findPort(msg: InitMsg): Promise<SerialPort> {
  if (!navigator.serial) {
    throw new Error("Web Serial is not available in this worker");
  }
  const ports = await navigator.serial.getPorts();
  const matches = ports.filter((p) => {
    const info = p.getInfo();
    return (
      (msg.usbVendorId === undefined || info.usbVendorId === msg.usbVendorId) &&
      (msg.usbProductId === undefined || info.usbProductId === msg.usbProductId)
    );
  });
  if (matches.length === 0) {
    throw new Error("Worker could not re-acquire the serial port (no authorized port matched)");
  }
  if (matches.length > 1) {
    console.warn(`[serial-worker] ${matches.length} authorized ports match; opening the first`);
  }
  return matches[0];
}

async function init(msg: InitMsg): Promise<void> {
  const port = await findPort(msg);
  // baudRate ref: pyserial defaults to 9600; the EBB is USB CDC so it's nominal.
  await port.open({ baudRate: 9600 });

  // The worker owns the port, so it detects unplug and closes directly — no
  // round-trip to the main thread (which is why the old closePort hack is gone).
  navigator.serial.addEventListener("disconnect", (e: Event) => {
    if (e.target === port) post({ kind: "disconnected" });
  });

  const channel: SerialChannel = {
    readable: port.readable,
    writable: port.writable,
    close: async () => {
      await port.close();
    },
  };
  host = createEbbHost(channel, msg.hardware, post);
  post({ kind: "ready" });
}

self.onmessage = (e: MessageEvent<InitMsg | HostCommand>) => {
  const msg = e.data;
  if (msg.kind === "init") {
    init(msg).catch((err) => post({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (!host) {
    console.error("[serial-worker] command before init:", msg.kind);
    return;
  }
  host.handle(msg);
};
