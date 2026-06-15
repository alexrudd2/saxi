// Bundles the full-plot worker spike (tools/plot-spike) for the browser, so it
// can import the real EBB/planner. Output lands in tools/plot-spike/dist; serve
// tools/plot-spike over http://localhost and open index.html.
//
//   node tools/build-plot-spike.mjs
//   npx serve tools/plot-spike
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: {
    "spike-main": "tools/plot-spike/spike-main.ts",
    "spike-worker": "tools/plot-spike/spike-worker.ts",
  },
  bundle: true,
  format: "esm",
  outdir: "tools/plot-spike/dist",
  logLevel: "info",
  define: {
    IS_WEB: "true",
    "process.env.DEBUG_SAXI_COMMANDS": '""',
    "process.env.SAXI_FIFO_DEPTH": '""',
  },
});

console.log("built tools/plot-spike/dist — now: npx serve tools/plot-spike");
