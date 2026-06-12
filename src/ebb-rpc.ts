/**
 * Message protocol between the main thread (ebb-proxy.ts) and the serial worker
 * (ebb-worker.ts).
 *
 * Granularity is one RPC per method call (one per motion during a plot), not
 * one per serial command: a motion's entire send->OK->send block stream runs
 * inside the worker, so postMessage latency never sits inside the serial cycle.
 */
import type { Hardware } from "./ebb.js";
import type { MotionData } from "./planning.js";

export interface EbbHostOptions {
  com?: string;
  hardware: Hardware;
}

/** The EBB methods the web server invokes through the proxy. */
export type EbbMethod =
  | "executeMotion"
  | "setPenHeight"
  | "setServoPowerTimeout"
  | "supportsSR"
  | "enableMotors"
  | "disableMotors"
  | "setFifoLedIndicator"
  | "configureFifoDepth"
  | "waitUntilMotorsIdle"
  | "command"
  | "changeHardware"
  | "resetTelemetry"
  | "logTelemetrySummary";

export type MainToWorker =
  | { kind: "call"; id: number; method: EbbMethod; args: unknown[] }
  // Out-of-band: the worker's event loop is free between serial replies, so a
  // cancel is delivered and applied immediately, not queued behind the
  // in-flight motion RPC.
  | { kind: "cancel" };

export type WorkerToMain =
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; error: string }
  // Connection state. `connected` is the source of truth (the mock serial port
  // has no path, yet is "connected"); `path` is the serial path for display.
  | { kind: "dev"; connected: boolean; path: string | null; hardware: Hardware };

/** A serialized motion as carried over the wire by an executeMotion call. */
export type MotionPayload = MotionData;
