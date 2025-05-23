import { elideShorterThan, merge as joinNearbyPaths, reorder as sortPaths } from "optimize-paths";
import { Device, type Plan, type PlanOptions, plan } from "./planning.js";
import { cropToMargins, dedupPoints, scaleToPaper } from "./util.js";
import { type Vec2, vmul, vrot } from "./vec.js";

// CSS, and thus SVG, defines 1px = 1/96th of 1in
// https://www.w3.org/TR/css-values-4/#absolute-lengths
const svgUnitsPerInch = 96;
const mmPerInch = 25.4;
const mmPerSvgUnit = mmPerInch / svgUnitsPerInch;

/**
 * Create a plan based on new vectors and plan options
 * @param inPaths 
 * @param planOptions 
 * @returns 
 */
export function replan(inPaths: (Vec2[] & { stroke?: string, groupId?: string })[], planOptions: PlanOptions): Plan {
  let paths = inPaths;
  const device = Device(planOptions.hardware);

  // Rotate drawing around center of paper to handle plotting portrait drawings
  // along y-axis of plotter
  // Rotate around the center of the page, but in SvgUnits (not mm)
  if (planOptions.rotateDrawing !== 0) {
    console.time("rotating paths");
    paths = paths.map((pl) => pl.map((p) => vrot(p,
      vmul({ x: planOptions.paperSize.size.x / 2, y: planOptions.paperSize.size.y / 2 }, 1 / mmPerSvgUnit),
      planOptions.rotateDrawing)
    ));
    console.timeEnd("rotating paths");
  }

  // Compute scaling using _all_ the paths, so it's the same no matter what
  // layers are selected.
  if (planOptions.fitPage) {
    paths = scaleToPaper(paths, planOptions.paperSize, planOptions.marginMm);
  } else {
    paths = paths.map(ps => ps.map(p => vmul(p, mmPerSvgUnit)));
    if (planOptions.cropToMargins) {
      paths = cropToMargins(paths, planOptions.paperSize, planOptions.marginMm);
    }
  }

  // Rescaling loses the stroke info, so refer back to the original paths to
  // filter based on the stroke. Rescaling doesn't change the number or order
  // of the paths.
  if (planOptions.layerMode === 'group') {
    paths = paths.filter((_path, i) => planOptions.selectedGroupLayers.has(inPaths[i].groupId));
  } else if (planOptions.layerMode === 'stroke') {
    paths = paths.filter((_path, i) => planOptions.selectedStrokeLayers.has(inPaths[i].stroke));
  }

  if (planOptions.pointJoinRadius > 0) {
    paths = paths.map((p) => dedupPoints(p, planOptions.pointJoinRadius));
  }

  if (planOptions.sortPaths) {
    console.time("sorting paths");
    paths = sortPaths(paths);
    console.timeEnd("sorting paths");
  }

  if (planOptions.minimumPathLength > 0) {
    console.time("eliding short paths");
    paths = elideShorterThan(paths, planOptions.minimumPathLength);
    console.timeEnd("eliding short paths");
  }

  if (planOptions.pathJoinRadius > 0) {
    console.time("joining nearby paths");
    paths = joinNearbyPaths(
      paths,
      planOptions.pathJoinRadius
    );
    console.timeEnd("joining nearby paths");
  }

  // Convert the paths to units of "steps".
  paths = paths.map((ps) => ps.map((p) => vmul(p, device.stepsPerMm)));

  // And finally, motion planning.
  console.time('planning pen motions');
  const theplan = plan(paths, {
    penUpPos: device.penPctToPos(planOptions.penUpHeight),
    penDownPos: device.penPctToPos(planOptions.penDownHeight),
    penDownProfile: {
      acceleration: planOptions.penDownAcceleration * device.stepsPerMm,
      maximumVelocity: planOptions.penDownMaxVelocity * device.stepsPerMm,
      corneringFactor: planOptions.penDownCorneringFactor * device.stepsPerMm
    },
    penUpProfile: {
      acceleration: planOptions.penUpAcceleration * device.stepsPerMm,
      maximumVelocity: planOptions.penUpMaxVelocity * device.stepsPerMm,
      corneringFactor: 0
    },
    penDropDuration: planOptions.penDropDuration,
    penLiftDuration: planOptions.penLiftDuration,
  },
    vmul(planOptions.penHome, device.stepsPerMm),
  );
  console.timeEnd("planning pen motions");

  return theplan;
}
