// De-risking spike for the serial worker: confirm the native serial
// binding (@serialport/bindings-cpp) loads and can talk to the EBB from inside
// a worker_thread. Run with the saxi server stopped so the port is free:
//   node tools/worker-serial-spike.mjs
//
// Proves three things, in order: (1) the N-API binding loads in a worker and
// list() works, (2) the port opens in the worker, (3) a V (version) query
// round-trips. If any step fails the fallback is a child_process host.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const isEBB = (p) =>
  p.manufacturer === "SchmalzHaus" ||
  p.manufacturer === "SchmalzHaus LLC" ||
  (p.vendorId === "04D8" && p.productId === "FD92");

if (isMainThread) {
  const w = new Worker(fileURLToPath(import.meta.url));
  w.on("message", (m) => console.log("[main] <-", JSON.stringify(m)));
  w.on("error", (e) => {
    console.error("[main] worker threw:", e);
    process.exitCode = 1;
  });
  w.on("exit", (code) => console.log(`[main] worker exited (${code})`));
} else {
  const run = async () => {
    // Step 1: native binding loads + list() in the worker.
    const { autoDetect } = await import("@serialport/bindings-cpp");
    const Binding = autoDetect();
    const ports = await Binding.list();
    parentPort.postMessage({
      step: "list",
      ok: true,
      ebbs: ports.filter(isEBB).map((p) => p.path),
      all: ports.map((p) => p.path),
    });

    const ebb = ports.find(isEBB);
    if (!ebb) {
      parentPort.postMessage({ step: "open", skipped: "no EBB connected" });
      return;
    }

    // Step 2 + 3: open the port in the worker and round-trip a V query.
    const { SerialPort } = await import("serialport");
    await new Promise((resolve) => {
      const port = new SerialPort({ path: ebb.path, baudRate: 9600 }, (err) => {
        if (err) {
          parentPort.postMessage({ step: "open", ok: false, error: String(err.message || err) });
          return resolve();
        }
        parentPort.postMessage({ step: "open", ok: true, path: ebb.path });
        let buf = "";
        const done = (msg) => {
          parentPort.postMessage(msg);
          try { port.close(() => resolve()); } catch { resolve(); }
        };
        const timer = setTimeout(() => done({ step: "V", ok: false, error: "timeout (no reply in 2s)" }), 2000);
        port.on("data", (d) => {
          buf += d.toString();
          if (/[\r\n]/.test(buf)) {
            clearTimeout(timer);
            done({ step: "V", ok: true, response: buf.trim() });
          }
        });
        port.write("V\r");
      });
      port.on("error", (e) => parentPort.postMessage({ step: "port-error", error: String(e.message || e) }));
    });
  };
  run().catch((e) => parentPort.postMessage({ step: "fatal", error: String((e && e.stack) || e) }));
}
