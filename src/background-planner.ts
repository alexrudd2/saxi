import { replan } from './massager';

self.addEventListener("message", (m) => {
  const {paths, planOptions, device} = m.data;
  const plan = replan(paths, planOptions, device);
  console.time("serializing");
  const serialized = plan.serialize();
  console.timeEnd("serializing");
  (self as any).postMessage(serialized);
});

export default {} as typeof Worker & {
  new(): Worker;
};
