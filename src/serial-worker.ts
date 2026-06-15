/**
 * Browser serial worker entry (esbuild entry point -> serial-worker.js).
 *
 * Receives the WebSerial port's transferred readable/writable streams, wraps
 * them in a SerialChannel, and runs the shared EBB host here — so the plot's
 * serial loop runs off the UI thread. close() can't reach the main thread's
 * SerialPort, so it asks the main thread to close it (by which point the host
 * has released the stream locks).
 */
import { createEbbHost, type EbbHost } from "./ebb-host.js";
import type { SerialChannel } from "./ebb.js";
import type { HostCommand, HostEvent, InitMsg } from "./serial-worker-rpc.js";

function post(event: HostEvent): void {
  (self as unknown as Worker).postMessage(event);
}

let host: EbbHost | null = null;

self.onmessage = (e: MessageEvent<InitMsg | HostCommand>) => {
  const msg = e.data;
  if (msg.kind === "init") {
    const channel: SerialChannel = {
      readable: msg.readable,
      writable: msg.writable,
      close: async () => post({ kind: "closePort" }),
    };
    host = createEbbHost(channel, msg.hardware, post);
    return;
  }
  host?.handle(msg);
};
