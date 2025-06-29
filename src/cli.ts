/**
 * Starting point for the server app (Command Line Interface).
 * Execute also one-off instructions on the device.
 */
import { readFileSync } from "node:fs";
import { flattenSVG } from "flatten-svg";
import { Window } from "svgdom";
import yargs from "yargs";
import { hideBin } from 'yargs/helpers';
import type { Hardware } from "./ebb.js";
import { replan } from "./massager.js";
import { PaperSize } from "./paper-size.js";
import { Device, type PlanOptions, defaultPlanOptions } from "./planning.js";
import { connectEBB, startServer } from "./server.js";
import { formatDuration } from "./util.js";

function parseSvg(svg: string) {
  const window = new Window;
  window.document.documentElement.innerHTML = svg;
  return window.document.documentElement;
}

/**
 * Process command arguments.
 * @param argv
 */
export function cli(argv: string[]): void {
  yargs(hideBin(process.argv))
    .strict()
    .option('hardware', {
      describe: 'select hardware type',
      choices: ['v3', 'brushless'] as const,
      default: 'v3',
      coerce: value => value as Hardware
    })
    .option('device', {
      alias: 'd',
      describe: 'device to connect to',
      type: 'string'
    })
    .command('plot <file>', 'plot an svg, then exit',
      yargs => yargs
        .positional("file", {
          type: "string",
          description: "File to plot",
        })
        .option("paper-size", {
          alias: "s",
          describe: "Paper size to use",
          coerce: (value) => {
            if (Object.hasOwn(PaperSize.standard, value)) {
              return PaperSize.standard[value];
            }
            const m = /^([0-9]*(?:\.[0-9]+)?)\s*x\s*([0-9]*(?:\.[0-9]+)?)\s*(cm|mm|in)$/i.exec(String(value).trim());
            if (m) {
              return new PaperSize({ x: Number(m[1]), y: Number(m[2]) });
            }
            throw new Error(`Paper size should be a standard size (${Object.keys(PaperSize.standard).join(", ")}) or a custom size such as "100x100mm" or "16x10in"`);
          },
          required: true
        })
        .option("landscape", {
          type: "boolean",
          description: "Place the long side of the paper on the x-axis"
        })
        .option("portrait", {
          type: "boolean",
          description: "Place the short side of the paper on the x-axis"
        })
        .option("margin", {
          describe: "Margin (in mm)",
          type: "number",
          default: defaultPlanOptions.marginMm,
          required: false
        })
        .option("pen-down-height", {
          describe: "Pen down height (%)",
          type: "number",
          default: defaultPlanOptions.penDownHeight,
          required: false
        })
        .option("pen-up-height", {
          describe: "Pen up height (%)",
          type: "number",
          default: defaultPlanOptions.penUpHeight,
          required: false
        })
        .option("pen-down-acceleration", {
          describe: "Acceleration when the pen is down (in mm/s^2)",
          type: "number",
          default: defaultPlanOptions.penDownAcceleration,
          required: false
        })
        .option("pen-down-max-velocity", {
          describe: "Maximum velocity when the pen is down (in mm/s)",
          type: "number",
          default: defaultPlanOptions.penDownMaxVelocity,
          required: false
        })
        .option("pen-down-cornering-factor", {
          describe: "Cornering factor when the pen is down",
          type: "number",
          default: defaultPlanOptions.penDownCorneringFactor,
          required: false
        })
        .option("pen-up-acceleration", {
          describe: "Acceleration when the pen is up (in mm/s^2)",
          type: "number",
          default: defaultPlanOptions.penUpAcceleration,
          required: false
        })
        .option("pen-up-max-velocity", {
          describe: "Maximum velocity when the pen is up (in mm/s)",
          type: "number",
          default: defaultPlanOptions.penUpMaxVelocity,
          required: false
        })
        .option("pen-drop-duration", {
          describe: "How long the pen takes to drop (in seconds)",
          type: "number",
          default: defaultPlanOptions.penDropDuration,
          required: false
        })
        .option("pen-lift-duration", {
          describe: "How long the pen takes to lift (in seconds)",
          type: "number",
          default: defaultPlanOptions.penLiftDuration,
          required: false
        })
        .option("sort-paths", {
          describe: "Re-order paths to minimize pen-up travel time",
          type: "boolean",
          default: true,
        })
        .option("fit-page", {
          describe: "Re-scale and position the image to fit on the page",
          type: "boolean",
          default: true,
        })
        .option("crop-to-margins", {
          describe: "Remove lines that fall outside the margins",
          type: "boolean",
          default: true,
        })
        .option("minimum-path-length", {
          describe: "Remove paths that are shorter than this length (in mm)",
          type: "number",
          default: defaultPlanOptions.minimumPathLength
        })
        .option("point-join-radius", {
          describe: "Point-joining radius (in mm)",
          type: "number",
          default: defaultPlanOptions.pointJoinRadius
        })
        .option("path-join-radius", {
          describe: "Path-joining radius (in mm)",
          type: "number",
          default: defaultPlanOptions.pathJoinRadius
        })
        .option("rotate-drawing", {
          describe: "Rotate drawing (in degrees)",
          type: "number",
          default: defaultPlanOptions.rotateDrawing
        })
        .check((args) => {
          if (args.landscape && args.portrait) {
            throw new Error("Only one of --portrait and --landscape may be specified");
          }
          return true;
        }),
      async args => {
        console.log("reading svg...");
        const svg = readFileSync(args.file, 'utf8');
        console.log("parsing svg...");
        const parsed = parseSvg(svg);
        console.log("flattening svg...");
        const lines = flattenSVG(parsed, {});
        console.log("generating motion plan...");
        const paperSize =
          args.landscape ? args['paper-size'].landscape
            : args.portrait ? args['paper-size'].portrait
              : args['paper-size'];
        const planOptions: PlanOptions = {
          paperSize,
          marginMm: args.margin,
          hardware: args.hardware,

          selectedGroupLayers: new Set([]), // TODO
          selectedStrokeLayers: new Set([]), // TODO
          layerMode: "all", // TODO

          penUpHeight: args["pen-up-height"],
          penDownHeight: args["pen-down-height"],

          penDownAcceleration: args["pen-down-acceleration"],
          penDownMaxVelocity: args["pen-down-max-velocity"],
          penDownCorneringFactor: args["pen-down-cornering-factor"],
          penUpAcceleration: args["pen-up-acceleration"],
          penUpMaxVelocity: args["pen-up-max-velocity"],

          penDropDuration: args["pen-drop-duration"],
          penLiftDuration: args["pen-lift-duration"],

          sortPaths: args["sort-paths"],
          fitPage: args["fit-page"],
          cropToMargins: args["crop-to-margins"],
          rotateDrawing: args["rotate-drawing"],

          minimumPathLength: args["minimum-path-length"],
          pathJoinRadius: args["path-join-radius"],
          pointJoinRadius: args["point-join-radius"],
        };
        const p = replan(lines, planOptions);
        console.log(`${p.motions.length} motions, estimated duration: ${formatDuration(p.duration())}`);
        console.log("connecting to plotter...");
        const ebb = await connectEBB(args.hardware, args.device);
        if (!ebb) {
          console.error("Couldn't connect to device!");
          process.exit(1);
        }
        console.log("plotting...");
        const startTime = +new Date;
        await ebb.executePlan(p);
        console.log(`done! took ${formatDuration((+new Date - startTime) / 1000)}`);
        await ebb.close();
      }
    )
    .command('pen [percent]', 'put the pen to [percent]', yargs => yargs
      .positional('percent', { type: 'number', description: 'percent height between 0 and 100', required: true })
      .check(args => args.percent >= 0 && args.percent <= 100),
    async args => {
      console.log('connecting to plotter...');
      const ebb = await connectEBB(args.hardware, args.device);
      if (!ebb) {
        console.error("Couldn't connect to device!");
        process.exit(1);
      }
      const device = Device(ebb.hardware);
      await ebb.setPenHeight(device.penPctToPos(args.percent), 1000);

      console.log(`moving to ${args.percent}%...`);
      await ebb.close();
    })
    .command('$0', 'run the saxi web server',
      args => args
        .option('port', {
          alias: 'p',
          describe: 'TCP port on which to listen',
          default: 9080,
          type: 'number',
        })
        .option('enable-cors', {
          describe: 'enable cross-origin resource sharing (CORS)',
          default: false,
          type: 'boolean',
        })
        .option('max-payload-size', {
          describe: 'maximum payload size to accept',
          default: '200mb',
        })
        .option('svgio-api-key', {
          describe: 'API Key - to enable AI image generation with SVG IO',
          default: '',
        }),
      args => {
        startServer(args.port, args.hardware, args.device, args['enable-cors'], args['max-payload-size'], args['svgio-api-key']);
      }
    )
    .parse(argv);
}
