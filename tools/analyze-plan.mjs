// Offline analysis of the motion plan saxi would generate for an SVG.
// Runs the same parse -> flatten -> replan pipeline as `saxi plot`, then
// reports block-duration statistics. Each block becomes one LM serial
// command, so blocks shorter than the serial round-trip time are at risk
// of starving the EBB's 1-deep motion FIFO (visible as stutter).
//
// Usage: node tools/analyze-plan.mjs <file.svg> [roundTripMs]

import { readFileSync } from "node:fs";
import { flattenSVG } from "flatten-svg";
import { createSVGWindow } from "svgdom";
import { replan } from "../dist/server/massager.js";
import { PaperSize } from "../dist/server/paper-size.js";
import { defaultPlanOptions } from "../dist/server/planning.js";

const file = process.argv[2];
const assumedRoundTripMs = Number(process.argv[3] ?? 4);
if (!file) {
  console.error("usage: node tools/analyze-plan.mjs <file.svg> [roundTripMs]");
  process.exit(1);
}

function parseSvg(svg) {
  const window = createSVGWindow();
  window.document.documentElement.innerHTML = svg;
  return window.document.documentElement;
}

console.error(`reading ${file}...`);
const svg = readFileSync(file, "utf8");
console.error("parsing & flattening...");
const lines = flattenSVG(parseSvg(svg), {});
console.error(`flattened to ${lines.length} polylines`);
const points = lines.reduce((n, l) => n + l.points.length, 0);
console.error(`total points: ${points}`);

console.error("planning (same options as UI/CLI defaults, ArchA landscape)...");
const planOptions = { ...defaultPlanOptions, layerMode: "all", paperSize: PaperSize.standard.ArchA.landscape };
const plan = replan(lines, planOptions);

const durationsMs = [];
let xyMotions = 0;
let penMotions = 0;
for (const motion of plan.motions) {
  if ("blocks" in motion) {
    xyMotions++;
    for (const b of motion.blocks) durationsMs.push(b.duration * 1000);
  } else {
    penMotions++;
  }
}

durationsMs.sort((a, b) => a - b);
const total = durationsMs.length;
const sum = durationsMs.reduce((a, b) => a + b, 0);
const pct = (p) => durationsMs[Math.min(total - 1, Math.floor((p / 100) * total))];
const below = (ms) => durationsMs.filter((d) => d < ms).length;

console.log(`\n=== ${file} ===`);
console.log(`motions: ${plan.motions.length} (${xyMotions} XY, ${penMotions} pen)`);
console.log(`blocks (= LM serial commands): ${total}`);
console.log(`plan duration: ${(sum / 1000).toFixed(1)} s`);
console.log(`block duration: median ${pct(50).toFixed(2)} ms, p10 ${pct(10).toFixed(2)} ms, p90 ${pct(90).toFixed(2)} ms`);
for (const ms of [1, 2, 4, 8, 15, 30]) {
  const n = below(ms);
  console.log(`  blocks < ${String(ms).padStart(2)} ms: ${String(n).padStart(7)}  (${((n / total) * 100).toFixed(1)}%)`);
}
const atRisk = below(assumedRoundTripMs);
console.log(
  `\nwith an assumed serial round-trip of ${assumedRoundTripMs} ms, ` +
    `${atRisk} blocks (${((atRisk / total) * 100).toFixed(1)}%) finish before the next command can arrive -> FIFO underrun risk`,
);
