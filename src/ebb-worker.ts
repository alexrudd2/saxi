/**
 * Serial worker host.
 *
 * Owns the serial port, the EBB instance, its telemetry, and the reconnect
 * loop. When loaded as a worker_thread it self-wires to parentPort; the
 * in-process transport (used under vitest) calls createEbbHost directly so the
 * serial-port mock still applies. The EBB class is untouched and stays
 * unit-testable in isolation.
 *
 * The point of the worker: a motion's send->OK->send block stream runs entirely
 * on this thread's event loop and heap, so express/ws/JSON/GC on the main
 * thread can no longer inject a multi-millisecond stall into the serial cycle —
 * the stutter that starves a 1-deep FIFO (firmware 2.x).
 */
import type { EBB, Hardware } from "./ebb.js";
import type { EbbHostOptions, EbbMethod, MainToWorker, WorkerToMain } from "./ebb-rpc.js";
import { type Motion, type MotionData, PenMotion, XYMotion } from "./planning.js";
import { ebbs } from "./serial-device.js";

export interface EbbHost {
  handleMessage(msg: MainToWorker): void;
  terminate(): Promise<void>;
}

function deserializeMotion(data: MotionData): Motion {
  if ("blocks" in data) return XYMotion.deserialize(data);
  if ("initialPos" in data) return PenMotion.deserialize(data);
  throw new Error(`Unknown motion payload: ${JSON.stringify(data)}`);
}

// The serial path the EBB opened, for the device-info broadcast. Mirrors the
// private-field read server.ts used before the worker existed.
function portPath(ebb: EBB): string | null {
  // biome-ignore lint/suspicious/noExplicitAny: read the SerialPortSerialPort's private path
  return (ebb.port as any)?._path ?? null;
}

export function createEbbHost(options: EbbHostOptions, postToMain: (msg: WorkerToMain) => void): EbbHost {
  let currentEbb: EBB | null = null;
  let hardware: Hardware = options.hardware;
  let stopped = false;

  const requireEbb = (): EBB => {
    if (!currentEbb) throw new Error("No EBB connected");
    return currentEbb;
  };

  async function dispatch(method: EbbMethod, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "executeMotion":
        return requireEbb().executeMotion(deserializeMotion(args[0] as MotionData));
      case "setPenHeight":
        return requireEbb().setPenHeight(args[0] as number, args[1] as number, args[2] as number | undefined);
      case "setServoPowerTimeout":
        return requireEbb().setServoPowerTimeout(args[0] as number, args[1] as boolean | undefined);
      case "supportsSR":
        return requireEbb().supportsSR();
      case "enableMotors":
        // biome-ignore lint/suspicious/noExplicitAny: RunningMicrostepMode is a numeric enum
        return requireEbb().enableMotors(args[0] as any);
      case "disableMotors":
        return requireEbb().disableMotors();
      case "setFifoLedIndicator":
        return requireEbb().setFifoLedIndicator(args[0] as boolean);
      case "configureFifoDepth":
        return requireEbb().configureFifoDepth();
      case "waitUntilMotorsIdle":
        return requireEbb().waitUntilMotorsIdle();
      case "command":
        // biome-ignore lint/suspicious/noExplicitAny: caller passes a valid EBBCommand
        return requireEbb().command(args[0] as any);
      case "changeHardware":
        hardware = args[0] as Hardware;
        currentEbb?.changeHardware(hardware);
        return undefined;
      case "resetTelemetry":
        currentEbb?.telemetry?.reset();
        return undefined;
      case "logTelemetrySummary":
        currentEbb?.telemetry?.logSummary();
        return undefined;
      default:
        throw new Error(`Unknown EBB method: ${method}`);
    }
  }

  // Reconnect loop: yields a connected EBB, then null on disconnect, forever.
  (async () => {
    for await (const device of ebbs(options.com, hardware)) {
      if (stopped) break;
      currentEbb = device;
      if (device) device.changeHardware(hardware);
      postToMain({ kind: "dev", connected: device != null, path: device ? portPath(device) : null, hardware });
    }
  })().catch((e) => {
    console.error(`[ebb-worker] connection loop failed: ${(e as Error).message}`);
  });

  return {
    handleMessage(msg: MainToWorker): void {
      if (msg.kind === "cancel") {
        currentEbb?.cancel();
        return;
      }
      // msg.kind === "call"
      dispatch(msg.method, msg.args).then(
        (value) => postToMain({ kind: "result", id: msg.id, value }),
        (error: Error) => postToMain({ kind: "error", id: msg.id, error: error?.message ?? String(error) }),
      );
    },
    async terminate(): Promise<void> {
      stopped = true;
      try {
        await currentEbb?.close();
      } catch {
        // best effort
      }
    },
  };
}

// Self-wire when launched as a worker_thread. Importing this module on the main
// thread (e.g. the in-process transport under vitest) is a no-op here.
async function wireWorkerThread(): Promise<void> {
  const { isMainThread, parentPort, workerData } = await import("node:worker_threads");
  if (isMainThread || !parentPort) return;
  const port = parentPort;
  const host = createEbbHost(workerData as EbbHostOptions, (msg) => port.postMessage(msg));
  port.on("message", (msg: MainToWorker) => host.handleMessage(msg));
}

void wireWorkerThread();
