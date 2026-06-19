/**
 * Message protocol between the UI/server (main thread) and the serial worker.
 *
 * The worker owns the EBB and the whole plot loop, so the surface is small:
 * commands in, lifecycle events out. A plan's entire motion stream runs inside
 * the worker, so postMessage latency never sits inside the serial send loop.
 */
import type { Hardware } from "./ebb.js";
import type { MotionData } from "./planning.js";

/**
 * Sent into the worker once, before any command. The main thread only does the
 * `requestPort()` user gesture (Window-only) and forwards the chosen device's
 * USB id; the worker re-acquires the port with `navigator.serial.getPorts()`
 * and opens it itself, so the serial byte pipe lives on the worker thread (not
 * proxied back through the main thread, which is what transferring the streams
 * silently did — main-thread jank then starved the board).
 */
export interface InitMsg {
  kind: "init";
  hardware: Hardware;
  usbVendorId?: number;
  usbProductId?: number;
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
  // The worker found and opened the port; the driver can report "connected".
  | { kind: "ready" }
  | { kind: "progress"; motionIdx: number }
  | { kind: "paused"; paused: boolean }
  | { kind: "finished" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string }
  // The port (owned by the worker) was physically unplugged.
  | { kind: "disconnected" };
