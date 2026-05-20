// Cribbed from https://github.com/fogleman/axi/blob/master/axi/planner.py
import type { Hardware } from "./ebb.js";
import { PaperSize } from "./paper-size.js";
import { type Vec2, vadd, vdot, vlen, vmul, vnorm, vsub } from "./vec.js";

const epsilon = 1e-9;

export interface PlanOptions {
  paperSize: PaperSize;
  marginMm: number;
  selectedStrokeLayers: Set<string>;
  selectedGroupLayers: Set<string>;
  layerMode: "group" | "stroke" | "all";

  penUpHeight: number;
  penDownHeight: number;
  pointJoinRadius: number;
  pathJoinRadius: number;

  penDownAcceleration: number;
  penDownMaxVelocity: number;
  penDownCorneringFactor: number;

  penUpAcceleration: number;
  penUpMaxVelocity: number;

  penDropDuration: number;
  penLiftDuration: number;

  sortPaths: boolean;
  rotateDrawing: number;
  fitPage: boolean;
  cropToMargins: boolean;

  minimumPathLength: number;
  hardware: Hardware;
  penHome: Vec2;
}

export const defaultPlanOptions: PlanOptions = {
  penUpHeight: 50,
  penDownHeight: 60,
  pointJoinRadius: 0,
  pathJoinRadius: 0.5,
  paperSize: PaperSize.standard.ArchA.landscape,
  marginMm: 20,
  selectedGroupLayers: new Set(),
  selectedStrokeLayers: new Set(),
  layerMode: "stroke",

  penDownAcceleration: 200,
  penDownMaxVelocity: 50,
  penDownCorneringFactor: 0.127,

  penUpAcceleration: 400,
  penUpMaxVelocity: 200,

  penDropDuration: 0.12,
  penLiftDuration: 0.12,

  sortPaths: true,
  rotateDrawing: 0,
  fitPage: true,
  cropToMargins: true,

  minimumPathLength: 0,
  hardware: "v3",
  penHome: { x: 0, y: 0 },
};

/**
 * An abstraction of all motion variables at a single point in time
 * (t), including position (p), distance (s), velocity (v), and acceleration (a).
 */
interface Instant {
  t: number;
  p: Vec2;
  s: number;
  v: number;
  a: number;
}

interface AccelerationProfile {
  acceleration: number;
  maximumVelocity: number;
  corneringFactor: number;
}

interface ToolingProfile {
  penDownProfile: AccelerationProfile;
  penUpProfile: AccelerationProfile;
  penDownPos: number; // int
  penUpPos: number; // int
  penLiftDuration: number;
  penDropDuration: number;
}

export const Device = (hardware = "v3"): Device => {
  if (hardware === "brushless") return AxidrawBrushless;
  if (hardware === "nextdraw-2234") return NextDraw2234;
  if (hardware === "idraw-h-se") return Axidraw; // https://github.com/alexrudd2/saxi/issues/298
  return Axidraw;
};

export interface Device {
  stepsPerMm: number;
  // Practical min/max that you might ever want the pen servo to go on the AxiDraw
  // Units: 83ns resolution pwm output.
  penServoMin: number; // pen down
  penServoMax: number; // pen up
  penPctToPos: (pct: number) => number;
}

// Defaults: penup at 12000 (1ms), pendown at 16000 (1.33ms).
const Axidraw: Device = {
  stepsPerMm: 5,

  penServoMin: 7500, // pen down
  penServoMax: 28000, // pen up

  penPctToPos(pct: number): number {
    const t = pct / 100.0;
    return Math.round(this.penServoMin * t + this.penServoMax * (1 - t));
  },
};

// brushless servo (https://shop.evilmadscientist.com/productsmenu/else?id=56)
const AxidrawBrushless: Device = {
  stepsPerMm: 5,

  penServoMin: 5400, // pen down
  penServoMax: 12600, // pen up

  penPctToPos(pct: number): number {
    const t = pct / 100.0;
    return Math.round(this.penServoMin * t + this.penServoMax * (1 - t));
  },
};

// NextDraw 2234 with brushless motor that requires 70%+ values
const NextDraw2234: Device = {
  stepsPerMm: 5,

  penServoMin: 19600, // pen down - 70% of range
  penServoMax: 28000, // pen up - full range

  penPctToPos(pct: number): number {
    const t = pct / 100.0;
    return Math.round(this.penServoMin * t + this.penServoMax * (1 - t));
  },
};

export const AxidrawFast: ToolingProfile = {
  penDownProfile: {
    acceleration: 200 * Axidraw.stepsPerMm,
    maximumVelocity: 50 * Axidraw.stepsPerMm,
    corneringFactor: 0.127 * Axidraw.stepsPerMm,
  },
  penUpProfile: {
    acceleration: 400 * Axidraw.stepsPerMm,
    maximumVelocity: 200 * Axidraw.stepsPerMm,
    corneringFactor: 0,
  },
  penUpPos: Axidraw.penPctToPos(50),
  penDownPos: Axidraw.penPctToPos(60),
  penDropDuration: 0.12,
  penLiftDuration: 0.12,
};

export const AxidrawBrushlessFast: ToolingProfile = {
  penDownProfile: {
    acceleration: 200 * AxidrawBrushless.stepsPerMm,
    maximumVelocity: 50 * AxidrawBrushless.stepsPerMm,
    corneringFactor: 0.127 * AxidrawBrushless.stepsPerMm,
  },
  penUpProfile: {
    acceleration: 400 * AxidrawBrushless.stepsPerMm,
    maximumVelocity: 200 * AxidrawBrushless.stepsPerMm,
    corneringFactor: 0,
  },
  penUpPos: AxidrawBrushless.penPctToPos(50),
  penDownPos: AxidrawBrushless.penPctToPos(60),
  penDropDuration: 0.08,
  penLiftDuration: 0.08,
};

export const NextDraw2234Fast: ToolingProfile = {
  penDownProfile: {
    acceleration: 200 * NextDraw2234.stepsPerMm,
    maximumVelocity: 50 * NextDraw2234.stepsPerMm,
    corneringFactor: 0.127 * NextDraw2234.stepsPerMm,
  },
  penUpProfile: {
    acceleration: 400 * NextDraw2234.stepsPerMm,
    maximumVelocity: 200 * NextDraw2234.stepsPerMm,
    corneringFactor: 0,
  },
  penUpPos: NextDraw2234.penPctToPos(50),
  penDownPos: NextDraw2234.penPctToPos(60),
  penDropDuration: 0.08,
  penLiftDuration: 0.08,
};

export class Block {
  public distance: number;

  constructor(
    public accel: number,
    public duration: number,
    public vInitial: number,
    public p1: Vec2,
    public p2: Vec2,
  ) {
    if (!(vInitial >= 0)) {
      throw new Error(`vInitial must be >= 0, but was ${vInitial}`);
    }
    if (!(vInitial + accel * duration >= -epsilon)) {
      throw new Error(`vFinal must be >= 0, but vInitial=${vInitial}, duration=${duration}, accel=${accel}`);
    }
    this.accel = accel;
    this.duration = duration;
    this.vInitial = vInitial;
    this.p1 = p1;
    this.p2 = p2;
    this.distance = vlen(vsub(p1, p2));
  }

  public get vFinal(): number {
    return Math.max(0, this.vInitial + this.accel * this.duration);
  }

  /**
   * Compute the motion at a given time.
   * @param tU The time at which to compute the motion.
   * @param dt The time offset.
   * @param ds The distance offset.
   * @return The motion at time tU.
   **/
  public instant(tU: number, dt = 0, ds = 0): Instant {
    const t = Math.max(0, Math.min(this.duration, tU));
    const a = this.accel;
    const v = this.vInitial + this.accel * t;
    const s = Math.max(0, Math.min(this.distance, this.vInitial * t + (a * t * t) / 2));
    const p = vadd(this.p1, vmul(vnorm(vsub(this.p2, this.p1)), s));
    return { t: t + dt, p, s: s + ds, v, a };
  }
}

export interface Motion {
  duration(): number;
}

/**
 * Pen Motion accross a single axis, represented as an initial positon, final position and duration.
 */
export class PenMotion implements Motion {
  public static deserialize(o: PenMotionData): PenMotion {
    return new PenMotion(o.initialPos, o.finalPos, o.duration);
  }

  constructor(
    public initialPos: number,
    public finalPos: number,
    public pDuration: number,
  ) {}

  public duration(): number {
    return this.pDuration;
  }

  public serialize(): PenMotionData {
    return {
      initialPos: this.initialPos,
      finalPos: this.finalPos,
      duration: this.pDuration,
    };
  }
}

interface PenMotionData {
  initialPos: number;
  finalPos: number;
  duration: number;
}

/**
 * Find insertion point of en element on a sorted array, to keep the order.
 * @param array
 * @param obj
 * @returns
 */
function sortedIndex(array: ArrayLike<number>, obj: number): number {
  let low = 0;
  let high = array.length;
  // binary search
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (array[mid] < obj) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

// Flat column layout for an XYMotion's blocks: one interleaved Float64Array,
// STRIDE numbers per block. Storing blocks as columns instead of ~3 heap
// objects each (a Block plus two Vec2) saves significant memory and GC pressure
const STRIDE = 8;
const ACCEL = 0;
const DURATION = 1;
const V_INITIAL = 2;
const P1X = 3;
const P1Y = 4;
const P2X = 5;
const P2Y = 6;
const DIST = 7;

/**
 * Validate a block's velocities and write it into the column array at index i.
 * Validation lives here (rather than in a Block constructor) so bad plans are
 * still rejected when packing on deserialize.
 */
function packBlock(
  cols: Float64Array,
  i: number,
  accel: number,
  duration: number,
  vInitial: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): void {
  if (!(vInitial >= 0)) {
    throw new Error(`vInitial must be >= 0, but was ${vInitial}`);
  }
  if (!(vInitial + accel * duration >= -epsilon)) {
    throw new Error(`vFinal must be >= 0, but vInitial=${vInitial}, duration=${duration}, accel=${accel}`);
  }
  const base = i * STRIDE;
  cols[base + ACCEL] = accel;
  cols[base + DURATION] = duration;
  cols[base + V_INITIAL] = vInitial;
  cols[base + P1X] = p1x;
  cols[base + P1Y] = p1y;
  cols[base + P2X] = p2x;
  cols[base + P2Y] = p2y;
  cols[base + DIST] = Math.hypot(p2x - p1x, p2y - p1y);
}

/**
 * XY Motion - across a 2 dimensional plane, a sequence of constant-acceleration
 * blocks stored as flat columns (see the STRIDE layout above).
 */
export class XYMotion implements Motion {
  /** Build from the short-lived Block objects the planner produces. */
  public static fromBlocks(blocks: Block[]): XYMotion {
    const cols = new Float64Array(blocks.length * STRIDE);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      packBlock(cols, i, b.accel, b.duration, b.vInitial, b.p1.x, b.p1.y, b.p2.x, b.p2.y);
    }
    return new XYMotion(cols, blocks.length);
  }

  /** Number of blocks. */
  public readonly length: number;
  public cols: Float64Array;
  // Prefix sums: ts[i]/ss[i] are the elapsed time/distance at block i's start.
  public ts: Float64Array;
  public ss: Float64Array;

  private constructor(cols: Float64Array, length: number, ts?: Float64Array, ss?: Float64Array) {
    this.cols = cols;
    this.length = length;

    if (ts && ss) {
      // transferred from worker
      this.ts = ts;
      this.ss = ss;
    } else {
      // computed locally
      this.ts = new Float64Array(length);
      this.ss = new Float64Array(length);
      let t = 0;
      let s = 0;
      for (let i = 0; i < length; i++) {
        const base = i * STRIDE;
        this.ts[i] = t;
        this.ss[i] = s;
        t += cols[base + DURATION];
        s += Math.hypot(cols[base + P2X] - cols[base + P1X], cols[base + P2Y] - cols[base + P1Y]);
      }
    }
  }

  public static fromBuffers(cols: Float64Array, ts: Float64Array, ss: Float64Array, length: number): XYMotion {
    return new XYMotion(cols, length, ts, ss);
  }

  // Per-block column accessors for the hot streaming loop (no Block allocation).
  public p1x(i: number): number {
    return this.cols[i * STRIDE + P1X];
  }
  public p1y(i: number): number {
    return this.cols[i * STRIDE + P1Y];
  }
  public p2x(i: number): number {
    return this.cols[i * STRIDE + P2X];
  }
  public p2y(i: number): number {
    return this.cols[i * STRIDE + P2Y];
  }
  public vInitial(i: number): number {
    return this.cols[i * STRIDE + V_INITIAL];
  }
  public blockDuration(i: number): number {
    return this.cols[i * STRIDE + DURATION];
  }
  public vFinal(i: number): number {
    const base = i * STRIDE;
    return Math.max(0, this.cols[base + V_INITIAL] + this.cols[base + ACCEL] * this.cols[base + DURATION]);
  }

  public get p1(): Vec2 {
    return { x: this.cols[P1X], y: this.cols[P1Y] };
  }
  public get p2(): Vec2 {
    const base = (this.length - 1) * STRIDE;
    return { x: this.cols[base + P2X], y: this.cols[base + P2Y] };
  }

  public duration(): number {
    if (this.length === 0) return 0;
    return this.ts[this.length - 1] + this.cols[(this.length - 1) * STRIDE + DURATION];
  }

  /** Start point of every block plus the final end point (for the UI preview). */
  public points(): Vec2[] {
    const pts: Vec2[] = new Array(this.length + 1);
    for (let i = 0; i < this.length; i++) {
      pts[i] = { x: this.cols[i * STRIDE + P1X], y: this.cols[i * STRIDE + P1Y] };
    }
    pts[this.length] = this.p2;
    return pts;
  }

  public instant(t: number): Instant {
    const idx = sortedIndex(this.ts, t);
    const blockIdx = this.ts[idx] === t ? idx : idx - 1;
    return this.blockInstant(blockIdx, t - this.ts[blockIdx], this.ts[blockIdx], this.ss[blockIdx]);
  }

  // Same math as Block.instant, computed over columns for block i.
  private blockInstant(i: number, tU: number, dt: number, ds: number): Instant {
    const base = i * STRIDE;
    const accel = this.cols[base + ACCEL];
    const duration = this.cols[base + DURATION];
    const vInitial = this.cols[base + V_INITIAL];
    const p1x = this.cols[base + P1X];
    const p1y = this.cols[base + P1Y];
    const p2x = this.cols[base + P2X];
    const p2y = this.cols[base + P2Y];
    const distance = this.cols[base + DIST];
    const t = Math.max(0, Math.min(duration, tU));
    const v = vInitial + accel * t;
    const s = distance > 0 ? Math.max(0, Math.min(distance, vInitial * t + (accel * t * t) / 2)) : 0;
    const frac = distance > 0 ? s / distance : 0;
    return {
      t: t + dt,
      p: { x: p1x + (p2x - p1x) * frac, y: p1y + (p2y - p1y) * frac },
      s: s + ds,
      v,
      a: accel,
    };
  }
}

// can be serialized to JSON for POST in the SaxiDriver
export type SerializedMotion =
  | { type: "xy"; length: number; cols: number[]; ts: number[]; ss: number[] }
  | { type: "pen"; initialPos: number; finalPos: number; duration: number };

// for efficient transfers with the worker
export type TransferredMotion =
  | { type: "xy"; length: number; cols: ArrayBuffer; ts: ArrayBuffer; ss: ArrayBuffer }
  | { type: "pen"; initialPos: number; finalPos: number; duration: number };

/**
 * Plotting Plan.
 * Contains a list of pen motions.
 */
export class Plan {
  constructor(public motions: (XYMotion | PenMotion)[]) {}

  public serialize(): SerializedMotion[] {
    return this.motions.map((m) => {
      if (m instanceof XYMotion) {
        return {
          type: "xy" as const,
          length: m.length,
          cols: Array.from(m.cols),
          ts: Array.from(m.ts),
          ss: Array.from(m.ss),
        };
      }
      return { type: "pen" as const, initialPos: m.initialPos, finalPos: m.finalPos, duration: m.pDuration };
    });
  }

  public static deserialize(data: SerializedMotion[]): Plan {
    return new Plan(
      data.map((m) =>
        m.type === "xy"
          ? XYMotion.fromBuffers(new Float64Array(m.cols), new Float64Array(m.ts), new Float64Array(m.ss), m.length)
          : new PenMotion(m.initialPos, m.finalPos, m.duration),
      ),
    );
  }

  public toTransferable(): TransferredMotion[] {
    return this.motions.map((m) => {
      if (m instanceof XYMotion) {
        return {
          type: "xy" as const,
          length: m.length,
          cols: m.cols.buffer as ArrayBuffer,
          ts: m.ts.buffer as ArrayBuffer,
          ss: m.ss.buffer as ArrayBuffer,
        };
      }
      return { type: "pen" as const, initialPos: m.initialPos, finalPos: m.finalPos, duration: m.pDuration };
    });
  }
  public static fromTransferable(data: TransferredMotion[]): Plan {
    return new Plan(
      data.map((m) =>
        m.type === "xy"
          ? XYMotion.fromBuffers(new Float64Array(m.cols), new Float64Array(m.ts), new Float64Array(m.ss), m.length)
          : new PenMotion(m.initialPos, m.finalPos, m.duration),
      ),
    );
  }

  /**
   * Calculate duration of the plan from a given start index.
   * @param start - the index of the first motion to consider (default: 0)
   * @returns duration of the plan (sec)
   */
  public duration(start = 0): number {
    return this.motions
      .slice(start)
      .map((m) => m.duration())
      .reduce((a, b) => a + b, 0);
  }
  public motion(i: number) {
    return this.motions[i];
  }

  public withPenHeights(penUpHeight: number, penDownHeight: number): Plan {
    let penMotionIndex = 0;
    return new Plan(
      this.motions.map((motion, j) => {
        if (motion instanceof XYMotion) {
          return motion;
        }
        if (motion instanceof PenMotion) {
          // TODO: Remove this hack by storing the pen-up/pen-down heights
          // in a single place, and reference them from the PenMotions.
          if (j === this.motions.length - 1) {
            return new PenMotion(penDownHeight, penUpHeight, motion.duration());
          }
          return penMotionIndex++ % 2 === 0
            ? new PenMotion(penUpHeight, penDownHeight, motion.duration())
            : new PenMotion(penDownHeight, penUpHeight, motion.duration());
        }
        throw new Error(`Wrong motion ${motion}`);
      }),
    );
  }
}

class Segment {
  public maxEntryVelocity = 0;
  public entryVelocity = 0;

  constructor(
    public p1: Vec2,
    public p2: Vec2,
    public blocks: Block[] = [],
  ) {}
  public length(): number {
    return vlen(vsub(this.p2, this.p1));
  }
  public direction(): Vec2 {
    return vnorm(vsub(this.p2, this.p1));
  }
}

function cornerVelocity(seg1: Segment, seg2: Segment, vMax: number, accel: number, cornerFactor: number): number {
  // https://onehossshay.wordpress.com/2011/09/24/improving_grbl_cornering_algorithm/
  const cosine = -vdot(seg1.direction(), seg2.direction());
  // assert(!cosine.isNaN, s"cosine was NaN: $seg1, $seg2, ${seg1.direction}, ${seg2.direction}")
  if (Math.abs(cosine - 1) < epsilon) {
    return 0;
  }
  const sine = Math.sqrt((1 - cosine) / 2);
  if (Math.abs(sine - 1) < epsilon) {
    return vMax;
  }
  const v = Math.sqrt((accel * cornerFactor * sine) / (1 - sine));
  // assert(!v.isNaN, s"v was NaN: $accel, $cornerFactor, $sine")
  return Math.min(v, vMax);
}

/** Represents a triangular velocity profile for moving in a straight line.
 *
 * {{{
 * +a ^____,        positive acceleration until maximum velocity is reached
 *    |    |
 *    |----|---> t
 *    |    |___
 * -a v             followed by negative acceleration until final velocity is reached
 *
 * +v ^    ,
 *    |  ,' `.
 * vi |,'     `  vf
 *    |
 *    +--------> t
 * }}}
 *
 * @param s1 the length of the first (accelerating) part of the profile.
 * @param s2 the length of the second (decelerating) part of the profile.
 * @param t1 the duration of the first (accelerating) part of the profile.
 * @param t2 the duration of the second (decelerating) part of the profile.
 * @param vMax the maximum velocity achieved during the motion.
 * @param p1 the initial position
 * @param p2 the position at v=vMax
 * @param p3 the final position
 */
interface Triangle {
  s1: number;
  s2: number;
  t1: number;
  t2: number;
  vMax: number;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
}
/** Compute a triangular velocity profile with piecewise constant acceleration.
 *
 * The maximum velocity is derived from the acceleration and the distance to be travelled.
 *
 * @param distance Distance to travel (equal to |p3-p1|).
 * @param initialVel Starting velocity, unit length per unit time.
 * @param finalVel Final velocity, unit length per unit time.
 * @param accel Magnitude of acceleration, unit length per unit time per unit time.
 * @param p1 Starting point.
 * @param p3 Ending point.
 * @return
 */
function computeTriangle(
  distance: number,
  initialVel: number,
  finalVel: number,
  accel: number,
  p1: Vec2,
  p3: Vec2,
): Triangle {
  const acceleratingDistance = (2 * accel * distance + finalVel * finalVel - initialVel * initialVel) / (4 * accel);
  const deceleratingDistance = distance - acceleratingDistance;
  const vMax = Math.sqrt(initialVel * initialVel + 2 * accel * acceleratingDistance);
  const t1 = (vMax - initialVel) / accel;
  const t2 = (finalVel - vMax) / -accel;
  const p2 = vadd(p1, vmul(vnorm(vsub(p3, p1)), acceleratingDistance));
  return { s1: acceleratingDistance, s2: deceleratingDistance, t1, t2, vMax, p1, p2, p3 };
}

/** Represents a trapezoidal velocity profile for moving in a straight line.
 *
 * {{{
 * +a ^____,           positive acceleration until maximum velocity is reached
 *    |    |
 *    |----+--+---> t  then zero acceleration while at maximum velocity
 *    |       |___
 * -a v                finally, negative acceleration until final velocity is reached
 *
 * +v ^    ,...     vmax
 *    |  ,'    `.
 * vi |,'        `  vf
 *    |
 *    +-----------> t
 * }}}
 *
 * @param s1 the length of the first (accelerating) part of the profile.
 * @param s2 the length of the second (constant velocity) part of the profile.
 * @param s3 the length of the third (decelerating) part of the profile.
 * @param t1 the duration of the first (accelerating) part of the profile.
 * @param t2 the duration of the second (constant velocity) part of the profile.
 * @param t3 the duration of the third (decelerating) part of the profile.
 * @param p1 the initial position.
 * @param p2 the position upon achieving v=vMax and beginning constant velocity interval.
 * @param p3 the position upon beginning to decelerate after v=vMax.
 * @param p4 the final position.
 */
interface Trapezoid {
  s1: number;
  s2: number;
  s3: number;
  t1: number;
  t2: number;
  t3: number;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
  p4: Vec2;
}
function computeTrapezoid(
  distance: number,
  initialVel: number,
  maxVel: number,
  finalVel: number,
  accel: number,
  p1: Vec2,
  p4: Vec2,
): Trapezoid {
  const t1 = (maxVel - initialVel) / accel;
  const s1 = ((maxVel + initialVel) / 2) * t1;
  const t3 = (finalVel - maxVel) / -accel;
  const s3 = ((finalVel + maxVel) / 2) * t3;
  const s2 = distance - s1 - s3;
  const t2 = s2 / maxVel;
  const dir = vnorm(vsub(p4, p1));
  const p2 = vadd(p1, vmul(dir, s1));
  const p3 = vadd(p1, vmul(dir, distance - s3));
  return { s1, s2, s3, t1, t2, t3, p1, p2, p3, p4 };
}

function dedupPoints(points: Vec2[], epsilon: number): Vec2[] {
  if (epsilon === 0) {
    return points;
  }
  const dedupedPoints: Vec2[] = [];
  dedupedPoints.push(points[0]);
  for (const p of points.slice(1)) {
    if (vlen(vsub(p, dedupedPoints[dedupedPoints.length - 1])) > epsilon) {
      dedupedPoints.push(p);
    }
  }
  return dedupedPoints;
}

/**
 * Plan a path, using a constant acceleration profile.
 * This function plans only a single x/y motion of the tool,
 * i.e. between a single pen-down/pen-up pair.
 *
 * @param points Sequence of points to pass through
 * @param profile Tooling profile to use
 * @return A plan of action
 */
function constantAccelerationPlan(points: Vec2[], profile: AccelerationProfile): XYMotion {
  const dedupedPoints = dedupPoints(points, epsilon);
  if (dedupedPoints.length === 1) {
    return XYMotion.fromBlocks([new Block(0, 0, 0, dedupedPoints[0], dedupedPoints[0])]);
  }
  const segments = dedupedPoints.slice(1).map((a, i) => new Segment(dedupedPoints[i], a));

  const accel = profile.acceleration;
  const vMax = profile.maximumVelocity;
  const cornerFactor = profile.corneringFactor;

  // Calculate the maximum entry velocity for each segment based on the angle between it
  // and the previous segment.
  segments.slice(1).forEach((seg2, i) => {
    const seg1 = segments[i];
    seg2.maxEntryVelocity = cornerVelocity(seg1, seg2, vMax, accel, cornerFactor);
  });

  // This is to force the velocity to zero at the end of the path.
  const lastPoint = dedupedPoints[dedupedPoints.length - 1];
  segments.push(new Segment(lastPoint, lastPoint));

  let i = 0;
  while (i < segments.length - 1) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    const distance = segment.length();
    const vInitial = segment.entryVelocity;
    const vExit = nextSegment.maxEntryVelocity;
    const p1 = segment.p1;
    const p2 = segment.p2;

    const m = computeTriangle(distance, vInitial, vExit, accel, p1, p2);
    if (m.s1 < -epsilon) {
      // We'd have to start decelerating _before we started on this segment_. backtrack.
      // In order enter this segment slow enough to be leaving it at vExit, we need to
      // compute a maximum entry velocity s.t. we can slow down in the distance we have.
      // TODO: verify this equation.
      segment.maxEntryVelocity = Math.sqrt(vExit * vExit + 2 * accel * distance);
      i -= 1;
    } else if (m.s2 <= 0) {
      // No deceleration.
      // TODO: shouldn't we check vMax here and maybe do trapezoid? should the next case below come first?
      const vFinal = Math.sqrt(vInitial * vInitial + 2 * accel * distance);
      const t = (vFinal - vInitial) / accel;
      segment.blocks = [new Block(accel, t, vInitial, p1, p2)];
      nextSegment.entryVelocity = vFinal;
      i += 1;
    } else if (m.vMax > vMax) {
      // Triangle profile would exceed maximum velocity, so top out at vMax.
      const z = computeTrapezoid(distance, vInitial, vMax, vExit, accel, p1, p2);
      segment.blocks = [
        new Block(accel, z.t1, vInitial, z.p1, z.p2),
        new Block(0, z.t2, vMax, z.p2, z.p3),
        new Block(-accel, z.t3, vMax, z.p3, z.p4),
      ];
      nextSegment.entryVelocity = vExit;
      i += 1;
    } else {
      // Accelerate, then decelerate.
      segment.blocks = [new Block(accel, m.t1, vInitial, m.p1, m.p2), new Block(-accel, m.t2, m.vMax, m.p2, m.p3)];
      nextSegment.entryVelocity = vExit;
      i += 1;
    }
  }
  const blocks: Block[] = [];
  for (const segment of segments) {
    for (const block of segment.blocks) {
      if (block.duration > epsilon) {
        blocks.push(block);
      }
    }
  }
  return XYMotion.fromBlocks(blocks);
}

/**
 * Build a Plan from a list of lines and profile parameters.
 * @param paths list of lines, each a list of Vec2
 * @param profile machine parameters
 * @param penHome initial location of the pen
 * @returns A full Plan
 */
export function plan(paths: Vec2[][], profile: ToolingProfile, penHome: Vec2 = { x: 0, y: 0 }): Plan {
  const motions: (XYMotion | PenMotion)[] = [];
  let curPos = penHome;

  const penMotions = {
    up: new PenMotion(profile.penDownPos, profile.penUpPos, profile.penLiftDuration),
    down: new PenMotion(profile.penUpPos, profile.penDownPos, profile.penDropDuration),
  };

  // For each path - move to the initial position, put the pen down, draw the path, bring pen up
  for (const path of paths) {
    const motion = constantAccelerationPlan(path, profile.penDownProfile);
    const position = constantAccelerationPlan([curPos, motion.p1], profile.penUpProfile);
    motions.push(position, penMotions.down, motion, penMotions.up);
    curPos = motion.p2;
  }

  // Final return to pen home
  motions.push(constantAccelerationPlan([curPos, penHome], profile.penUpProfile));
  return new Plan(motions);
}
