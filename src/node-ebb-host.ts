/**
 * Main-thread side of the Node serial host (the server's analog of
 * WebSerialDriver). Builds a SerialChannel over the native serial port and runs
 * the shared EBB host, surfacing its events via a callback so server.ts can
 * drive plot/cancel/pause uniformly.
 *
 * Note: this runs IN-PROCESS, not on a worker_thread. The WebSerial build runs
 * the host on a Web Worker, but serialport's native binding faults
 * ("HandleScope::HandleScope Entering the V8 API without proper locking") the
 * moment its I/O callbacks fire inside a worker_thread, so the Node loop stays
 * on the main thread (as it always has upstream). The unification win is the
 * shared ebb-host; the deep FIFO (#309) is what keeps the main-thread loop
 * stutter-free. The HostTransport seam leaves room for an out-of-process
 * (child_process) transport later if true isolation is ever needed.
 */
import { createEbbHost } from "./ebb-host.js";
import type { Hardware, SerialChannel } from "./ebb.js";
import { SerialPortSerialPort } from "./serialport-serialport.js";
import type { HostCommand, HostEvent } from "./serial-worker-rpc.js";

export interface HostTransport {
  /** Forward a command to the EBB host. */
  handle(cmd: HostCommand): void;
  /** Tear down the host and release the port. */
  close(): Promise<void>;
}

/**
 * Open the port, build the channel and run the shared host in this process.
 * Emits "ready" once the port is open (and "disconnected" on unplug), so the
 * server's connect loop treats it like the browser worker's event stream.
 */
export async function createInProcessTransport(
  com: string,
  hardware: Hardware,
  onEvent: (event: HostEvent) => void,
): Promise<HostTransport> {
  const serial = new SerialPortSerialPort(com);
  await serial.open({ baudRate: 9600 });
  serial.addEventListener("disconnect", () => onEvent({ kind: "disconnected" }), { once: true });

  const channel: SerialChannel = {
    readable: serial.readable,
    writable: serial.writable,
    close: () => serial.close(),
  };
  const host = createEbbHost(channel, hardware, onEvent);
  // The port is already open by the time we return; signal readiness like the worker.
  queueMicrotask(() => onEvent({ kind: "ready" }));

  return {
    handle(cmd: HostCommand): void {
      host.handle(cmd);
    },
    async close(): Promise<void> {
      host.handle({ kind: "close" });
    },
  };
}
