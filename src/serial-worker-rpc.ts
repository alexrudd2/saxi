/**
 * Message protocol between the UI/server (main thread) and the serial worker.
 *
 * The worker owns the EBB and the whole plot loop, so the surface is small:
 * commands in, lifecycle events out. A plan's entire motion stream runs inside
 * the worker, so postMessage latency never sits inside the serial send loop.
 */
import type { Hardware } from "./ebb.js";
import type { MotionData } from "./planning.js";

/** Sent into the worker once, before any command, to hand over the port. */
export interface InitMsg {
  kind: "init";
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  hardware: Hardware;
}

/** Commands from the main thread to the worker. */
export type HostCommand =
  | { kind: "plot"; plan: MotionData[] }
  | { kind: "cancel" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "setPenHeight"; height: number; rate: number }
  | { kind: "limp" }
  | { kind: "changeHardware"; hardware: Hardware }
  | { kind: "close" };

/** Lifecycle events from the worker back to the main thread. */
export type HostEvent =
  | { kind: "progress"; motionIdx: number }
  | { kind: "paused"; paused: boolean }
  | { kind: "finished" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string }
  // Browser only: the worker has torn the EBB down and released the transferred
  // streams; the main thread (which owns the SerialPort) should close it.
  | { kind: "closePort" };
