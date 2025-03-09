/**
 * Worker for serializing a plan.
 * Meant to be invoked through the Worker interface.
 */
import { replan } from './massager';

self.addEventListener("message", (m) => {
  const { paths, planOptions } = m.data;
  const plan = replan(paths, planOptions);
  console.time("serializing");
  const serialized = plan.serialize();
  console.timeEnd("serializing");
  self.postMessage(serialized);
});

export {};
