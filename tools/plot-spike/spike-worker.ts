/**
 * Full-plot spike — worker side.
 *
 * Receives the transferred WebSerial streams plus a serialized plan, builds the
 * REAL EBB from a SerialChannel over those streams, and runs the whole plot
 * (enable motors -> every motion -> idle -> disable) entirely on this worker's
 * thread. Finally exercises EBB.close() teardown: it aborts the read pipe and
 * releases the writer here, then asks the main thread to close the port.
 *
 * If this draws the square and closes cleanly, the unified-worker design is
 * fully de-risked: real EBB, real motion, real teardown, all off the main
 * thread over transferred streams.
 */
import { EBB, type Hardware, type SerialChannel } from "../../src/ebb";
import { type MotionData, Plan } from "../../src/planning";

interface InitMsg {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  plan: MotionData[];
  hardware: Hardware;
}

function post(step: string, value: unknown, isError = false): void {
  (self as unknown as Worker).postMessage({ step, value, isError });
}

self.onmessage = async (e: MessageEvent<InitMsg>) => {
  const { readable, writable, plan: planData, hardware } = e.data;

  // The worker can't touch the main thread's SerialPort object, so close() just
  // asks main to close it — by which point EBB.close() has already released the
  // stream locks here.
  const channel: SerialChannel = {
    readable,
    writable,
    close: async () => post("closePort", null),
  };

  try {
    post("init", "streams received in worker; constructing EBB");
    const ebb = new EBB(channel, hardware);
    const plan = Plan.deserialize(planData);
    post("plan", `${plan.motions.length} motions deserialized`);

    await ebb.configureFifoDepth(); // also exercises the merged FIFO fix in the worker
    await ebb.enableMotors(1); // 16x microstepping
    let i = 0;
    for (const motion of plan.motions) {
      await ebb.executeMotion(motion);
      post("progress", `motion ${++i}/${plan.motions.length}`);
    }
    await ebb.waitUntilMotorsIdle();
    await ebb.disableMotors();
    post("plotted", "all motions executed ✓");

    await ebb.close(); // teardown under test
    post("done", "EBB closed cleanly from the worker ✓");
  } catch (err) {
    post("error", err instanceof Error ? err.message : String(err), true);
  }
};
