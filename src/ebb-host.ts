/**
 * Serial worker host — environment-agnostic.
 *
 * Owns an EBB over a SerialChannel and runs the entire plot loop (the same loop
 * the WebSerial driver and the Node server used to run on their main threads),
 * driven by messages. Both transports — the browser DOM worker and the Node
 * worker_thread — build a SerialChannel and hand it here, so the serial
 * send->OK->send loop runs on the worker's own event loop and heap, where
 * main-thread React / express / ws / GC cannot stall it.
 */
import { EBB, type Hardware, type SerialChannel } from "./ebb.js";
import { Device, type MotionData, PenMotion, Plan } from "./planning.js";
import type { HostCommand, HostEvent } from "./serial-worker-rpc.js";

export interface EbbHost {
  handle(cmd: HostCommand): void;
}

export function createEbbHost(
  channel: SerialChannel,
  hardware: Hardware,
  postEvent: (event: HostEvent) => void,
): EbbHost {
  const ebb = new EBB(channel, hardware);
  let unpaused: Promise<void> | null = null;
  let signalUnpause: (() => void) | null = null;
  let cancelRequested = false;

  async function plot(planData: MotionData[]): Promise<void> {
    const plan = Plan.deserialize(planData);
    unpaused = null;
    cancelRequested = false;
    await ebb.configureFifoDepth(); // firmware >= 3.0.0 FIFO deepening; no-op otherwise
    await ebb.enableMotors(1); // 16x microstepping, matches AxiDraw defaults

    let motionIdx = 0;
    let penIsUp = true;
    for (const motion of plan.motions) {
      postEvent({ kind: "progress", motionIdx });
      await ebb.executeMotion(motion);
      if (motion instanceof PenMotion) {
        penIsUp = motion.initialPos < motion.finalPos;
      }
      if (unpaused && penIsUp) {
        await unpaused;
        postEvent({ kind: "paused", paused: false });
      }
      if (cancelRequested) break;
      motionIdx += 1;
    }

    if (cancelRequested) {
      if (!penIsUp) {
        // Lift the pen before homing, or it drags across the work on the way back.
        const penMotion = plan.motions.find((m): m is PenMotion => m instanceof PenMotion);
        const penUpPosition = penMotion
          ? Math.max(penMotion.initialPos, penMotion.finalPos)
          : Device(ebb.hardware).penPctToPos(50);
        await ebb.setPenHeight(penUpPosition, 1000);
        await ebb.command("HM,4000"); // home without 3rd/4th args
      }
      postEvent({ kind: "cancelled" });
    } else {
      postEvent({ kind: "finished" });
    }

    await ebb.waitUntilMotorsIdle();
    await ebb.disableMotors();
  }

  async function setPenHeight(height: number, rate: number): Promise<void> {
    if (await ebb.supportsSR()) {
      await ebb.setServoPowerTimeout(10000, true);
    }
    await ebb.setPenHeight(height, rate);
  }

  function pause(): void {
    unpaused = new Promise((resolve) => {
      signalUnpause = resolve;
    });
    postEvent({ kind: "paused", paused: true });
  }

  function resume(): void {
    const signal = signalUnpause;
    unpaused = null;
    signalUnpause = null;
    signal?.();
  }

  const fail = (e: unknown) => postEvent({ kind: "error", message: e instanceof Error ? e.message : String(e) });

  return {
    handle(cmd: HostCommand): void {
      switch (cmd.kind) {
        case "plot":
          plot(cmd.plan).catch(fail);
          break;
        case "cancel":
          cancelRequested = true;
          break;
        case "pause":
          pause();
          break;
        case "resume":
          resume();
          break;
        case "setPenHeight":
          setPenHeight(cmd.height, cmd.rate).catch(fail);
          break;
        case "limp":
          ebb.disableMotors().catch(fail);
          break;
        case "changeHardware":
          ebb.changeHardware(cmd.hardware);
          break;
        case "close":
          ebb.close().catch(fail);
          break;
      }
    },
  };
}
