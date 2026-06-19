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
  let paused = false;

  async function plot(planData: MotionData[]): Promise<void> {
    const plan = Plan.deserialize(planData);
    unpaused = null;
    signalUnpause = null;
    paused = false;
    cancelRequested = false;
    ebb.resetStop();
    ebb.clearPause();

    // Pen up/down positions for this plan, used to lift the pen on pause/cancel
    // and lower it again on resume. EBB doesn't track pen state — the host does.
    const penMotion = plan.motions.find((m): m is PenMotion => m instanceof PenMotion);
    const penUpPosition = penMotion
      ? Math.max(penMotion.initialPos, penMotion.finalPos)
      : Device(ebb.hardware).penPctToPos(50);
    const penDownPosition = penMotion
      ? Math.min(penMotion.initialPos, penMotion.finalPos)
      : Device(ebb.hardware).penPctToPos(60);

    let penIsUp = true;

    // Pause checkpoint, run both mid-motion (via the EBB pause hook, between LM
    // blocks) and at motion boundaries. Let the FIFO drain so the machine
    // actually stops, lift the pen if we paused mid-stroke, wait for resume,
    // then lower it so the loop carries on from the same position.
    const pauseGate = async (): Promise<void> => {
      if (!paused) return;
      await ebb.waitUntilMotorsIdle();
      const penWasDown = !penIsUp;
      if (penWasDown) await ebb.setPenHeight(penUpPosition, 1000);
      await unpaused;
      postEvent({ kind: "paused", paused: false });
      if (penWasDown && !cancelRequested) await ebb.setPenHeight(penDownPosition, 1000);
    };
    ebb.setPauseHook(pauseGate);

    await ebb.configureFifoDepth(); // firmware >= 3.0.0 FIFO deepening; no-op otherwise
    await ebb.enableMotors(1); // 16x microstepping, matches AxiDraw defaults

    let motionIdx = 0;
    try {
      for (const motion of plan.motions) {
        postEvent({ kind: "progress", motionIdx });
        await ebb.executeMotion(motion);
        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos < motion.finalPos;
        }
        await pauseGate(); // catch a pause requested at the motion boundary
        if (cancelRequested) break;
        motionIdx += 1;
      }
    } catch (e) {
      // Cancellation unwinds cooperatively (no throw); swallow any error that
      // races in during a cancel, but surface real plot failures.
      if (!cancelRequested) throw e;
    } finally {
      ebb.setPauseHook(null);
    }

    if (cancelRequested) {
      // requestStop() stopped the host sending, but the board may still be
      // draining its motion FIFO; let it stop before homing, or HM grinds
      // against the buffered moves (a deep FIFO widens that window).
      await ebb.waitUntilMotorsIdle();
      if (!penIsUp) {
        // Lift the pen before homing, or it drags across the work on the way back.
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

  function requestCancel(): void {
    cancelRequested = true;
    // Cooperatively stop the streaming loop after the current block, so the
    // current motion returns promptly without leaving its (possibly huge) tail
    // of blocks to send. This keeps the command stream in sync (unlike
    // cancel()), so the post-cancel waitUntilMotorsIdle/home commands work.
    ebb.requestStop();
    // If paused, release the gate so the loop can reach the cancel check.
    paused = false;
    ebb.clearPause();
    const signal = signalUnpause;
    unpaused = null;
    signalUnpause = null;
    signal?.();
  }

  async function setPenHeight(height: number, rate: number): Promise<void> {
    if (await ebb.supportsSR()) {
      await ebb.setServoPowerTimeout(10000, true);
    }
    await ebb.setPenHeight(height, rate);
  }

  function pause(): void {
    if (paused) return;
    paused = true;
    unpaused = new Promise((resolve) => {
      signalUnpause = resolve;
    });
    // Trip the between-block checkpoint so the pause takes effect mid-motion,
    // not just at the next motion boundary.
    ebb.requestPause();
    postEvent({ kind: "paused", paused: true });
  }

  function resume(): void {
    if (!paused) return;
    paused = false;
    ebb.clearPause();
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
          requestCancel();
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
