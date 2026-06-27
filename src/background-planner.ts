/**
 * Worker for serializing a plan.
 * Meant to be invoked through the Worker interface.
 */
import { replan } from "./massager";
import { XYMotion } from "./planning";

self.addEventListener("message", (m) => {
  const { paths, planOptions } = m.data;
  const plan = replan(paths, planOptions);
  console.time("serializing");
  const motions = plan.toTransferable();
  const buffers = plan.motions
    .filter((m): m is XYMotion => m instanceof XYMotion)
    .flatMap((m) => [m.cols.buffer, m.ts.buffer, m.ss.buffer]);
  console.timeEnd("serializing");
  self.postMessage(motions, { transfer: buffers });
});
