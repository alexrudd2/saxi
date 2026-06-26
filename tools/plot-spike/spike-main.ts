/**
 * Full-plot spike — main thread.
 *
 * Plans a tiny (~26 mm) square with the REAL planner, opens the EBB with
 * navigator.serial, transfers the port's streams + the serialized plan into a
 * Web Worker, and lets the worker drive the whole plot. The main thread does no
 * serial I/O during the plot — exactly the unified-worker design. On teardown
 * the worker releases its stream locks, then signals us to close the port.
 */
import type { Path } from "flatten-svg";
import { defaultPlanOptions } from "../../src/planning";
import { replan } from "../../src/massager";

const logEl = document.getElementById("log") as HTMLDivElement;
function log(msg: string, isError = false): void {
  const line = document.createElement("div");
  if (isError) line.className = "err";
  line.textContent = msg;
  logEl.appendChild(line);
}

// A ~26 mm square near the origin (svg user units; ~0.26 mm each).
const square = {
  points: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
    { x: 0, y: 0 },
  ],
} as unknown as Path;

// port.close() rejects while either transferred stream is still locked. After
// the worker releases its locks the unlock takes a moment to cross the thread
// boundary, so retry the close until it lands (or give up after ~2s).
async function closePortWhenUnlocked(port: SerialPort): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await port.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await port.close(); // final attempt; surface the error if still stuck
}

document.getElementById("go")?.addEventListener("click", async () => {
  logEl.textContent = "";
  if (!("serial" in navigator)) {
    log("navigator.serial unavailable — use Chrome/Edge over http://localhost.", true);
    return;
  }
  try {
    log("planning a ~26 mm square…");
    // fitPage/cropToMargins would scale the square to fill the sheet (~188 mm on
    // ArchA); disable them so 100 svg units plot at their literal ~26 mm.
    const plan = replan([square], {
      ...defaultPlanOptions,
      layerMode: "all",
      fitPage: false,
      cropToMargins: false,
    });
    const planData = plan.serialize();
    log(`plan ready: ${plan.motions.length} motions, ~${plan.duration().toFixed(1)} s`);

    log("requesting port…");
    const port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x04d8, usbProductId: 0xfd92 }],
    });
    await port.open({ baudRate: 9600 });
    log("port opened on main thread ✓");

    const worker = new Worker(new URL("./spike-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ step: string; value: unknown; isError: boolean }>) => {
      const { step, value, isError } = e.data;
      log(`[${step}] ${value ?? ""}`, isError);
      if (step === "closePort") {
        // The worker released its locks on the transferred streams; that unlock
        // has to propagate to this realm before port.close() will accept it, so
        // retry briefly until it does.
        closePortWhenUnlocked(port).then(
          () => log("port closed on main thread ✓"),
          (err) => log(`port close failed: ${err.message}`, true),
        );
      }
      if (step === "done" || step === "error") worker.terminate();
    };
    worker.onerror = (e) => log(`worker error: ${e.message}`, true);

    log("transferring streams + plan into worker…");
    worker.postMessage({ readable: port.readable, writable: port.writable, plan: planData, hardware: "v3" }, [
      port.readable,
      port.writable,
    ]);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err), true);
  }
});
