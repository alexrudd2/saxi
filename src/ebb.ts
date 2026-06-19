import { type Block, type Motion, PenMotion, type Plan, XYMotion } from "./planning.js";
import { type Vec2, vsub } from "./vec.js";

enum MicrostepMode {
  DISABLED = 0,
  SIXTEENTH = 1,
  EIGHTH = 2,
  QUARTER = 3,
  HALF = 4,
  FULL = 5,
}
type RunningMicrostepMode = Exclude<MicrostepMode, MicrostepMode.DISABLED>;

type PowerState = 0 | 1;

type EBBCommand =
  // Motor commands
  | `EM,${MicrostepMode},${MicrostepMode}`

  // Movement commands
  | `HM,${number}` // home with step frequency
  | `HM,${number},${number},${number}` // home to specific position
  | `XM,${number},${number},${number}` // mixed-axis move
  | `LM,${number},${number},${number},${number},${number},${number}` // low-level move

  // Configure commands
  | `CU,${number},${number}` // configure user options (e.g. CU,4,n = motion FIFO depth, fw >= 3.0.0)

  // Servo commands
  | `S2,${number},${number}` // basic servo position
  | `S2,${number},${number},${number}` // with rate
  | `S2,${number},${number},${number},${number}` // with rate and delay
  | `S2,0,${number}` // disable servo output
  | `SR,${number}` // servo power timeout
  | `SR,${number},${PowerState}`; // servo power timeout with immediate state

type EBBQuery =
  // queries that return a single line
  | "V" // version
  | "QM"; // query motors

type EBBQueryM =
  // queries that return multiple lines
  | "QB" // query button
  | "QC" // query configuration
  | `QU,${number}`; // query utility (fw >= 3.0.0), e.g. QU,2 = max FIFO depth

/** Split d into its fractional and integral parts */
function modf(d: number): [number, number] {
  const intPart = Math.floor(d);
  const fracPart = d - intPart;
  return [fracPart, intPart];
}

export type Hardware = "v3" | "brushless" | "nextdraw-2234";

/**
 * Opt-in (SAXI_TRACE_TIMING=1) per-block timing trace for the LM streaming loop.
 *
 * It separates the two sources of motion gaps so we can tell which one is
 * stuttering: the host-side `gap` (time between one block's OK and sending the
 * next — where a GC / event-loop / main-thread stall lands) versus the `rtt`
 * (the LM command's send->OK round-trip, which is board+serial bound, and at a
 * 1-deep FIFO also includes waiting for the single slot to free). At FIFO depth
 * 1 a smooth plot needs gap≈0; any host gap directly starves the steppers.
 */
class BlockTimingTrace {
  private static readonly STALL_MS = 4; // a host gap over this would empty a 1-deep FIFO
  private static readonly WINDOW = 1000; // blocks per rolling summary line

  static maybeStart(): BlockTimingTrace | null {
    return process.env.SAXI_TRACE_TIMING ? new BlockTimingTrace() : null;
  }

  private count = 0;
  private sumPlanned = 0;
  private sumRtt = 0;
  private sumGap = 0;
  private maxGap = 0;
  private maxRtt = 0;
  private stalls = 0;
  private windowStart = 0;
  private windowGapSum = 0;
  private windowMaxGap = 0;
  private windowRttSum = 0;
  private windowMaxRtt = 0;

  record(index: number, plannedMs: number, rttMs: number, gapMs: number): void {
    this.count += 1;
    this.sumPlanned += plannedMs;
    this.sumRtt += rttMs;
    this.sumGap += gapMs;
    if (gapMs > this.maxGap) this.maxGap = gapMs;
    if (rttMs > this.maxRtt) this.maxRtt = rttMs;
    this.windowGapSum += Math.max(0, gapMs);
    if (gapMs > this.windowMaxGap) this.windowMaxGap = gapMs;
    this.windowRttSum += rttMs;
    if (rttMs > this.windowMaxRtt) this.windowMaxRtt = rttMs;

    if (gapMs > BlockTimingTrace.STALL_MS) {
      this.stalls += 1;
      console.log(
        `[timing] block ${index}: host gap ${gapMs.toFixed(1)}ms ` +
          `(planned move ${plannedMs.toFixed(1)}ms, rtt ${rttMs.toFixed(1)}ms) — FIFO would run dry here`,
      );
    }
    if (index - this.windowStart >= BlockTimingTrace.WINDOW) {
      const n = index - this.windowStart;
      console.log(
        `[timing] blocks ${this.windowStart}-${index}: ` +
          `host gap ${this.windowGapSum.toFixed(0)}ms total (max ${this.windowMaxGap.toFixed(1)}ms) | ` +
          `rtt mean ${(this.windowRttSum / n).toFixed(1)}ms (max ${this.windowMaxRtt.toFixed(1)}ms)`,
      );
      this.windowStart = index;
      this.windowGapSum = 0;
      this.windowMaxGap = 0;
      this.windowRttSum = 0;
      this.windowMaxRtt = 0;
    }
  }

  summarize(): void {
    if (this.count === 0) return;
    const wallS = (this.sumRtt + this.sumGap) / 1000;
    const plannedS = this.sumPlanned / 1000;
    const overheadS = this.sumGap / 1000;
    console.log(
      `[timing] XYMotion done: ${this.count} blocks | ` +
        `planned ${plannedS.toFixed(1)}s, wall ${wallS.toFixed(1)}s, host overhead ${overheadS.toFixed(1)}s | ` +
        `mean gap ${(this.sumGap / this.count).toFixed(2)}ms (max ${this.maxGap.toFixed(1)}ms), ` +
        `mean rtt ${(this.sumRtt / this.count).toFixed(2)}ms (max ${this.maxRtt.toFixed(1)}ms) | ` +
        `host stalls >${BlockTimingTrace.STALL_MS}ms: ${this.stalls}`,
    );
  }
}

/**
 * The minimal serial transport the EBB needs: a byte stream in each direction
 * plus a close hook. A WebSerial/Node `SerialPort` satisfies this structurally,
 * and so does a pair of streams transferred into a worker (see ebb-worker),
 * which is how the EBB runs off the main thread in the browser build.
 */
export interface SerialChannel {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

type CommandGenerator<TReturn = unknown> = Iterator<unknown, TReturn, string> & {
  resolve: (value: TReturn) => void;
  reject: (reason: Error) => void;
};

export class EBB {
  public port: SerialChannel;
  private commandQueue: CommandGenerator[];
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Resolves when the read loop has stopped and released its lock. */
  private readableClosed: Promise<void>;
  public hardware: Hardware;

  private microsteppingMode = MicrostepMode.DISABLED;

  /** Accumulated XY error, used to correct for movements with sub-step resolution */
  private error: Vec2 = { x: 0, y: 0 };

  private cachedFirmwareVersion: [number, number, number] | undefined = undefined;

  /** Set by requestStop() to cooperatively end the LM streaming loop between blocks. */
  private stopRequested = false;

  /** Set by requestPause() to make the LM streaming loop run the pause hook before the next block. */
  private pauseRequested = false;
  /**
   * Host-provided gate the LM streaming loop awaits between blocks when a pause
   * has been requested. The host uses it to let the motion FIFO drain, lift the
   * pen, wait for resume, then lower the pen — it owns the pen state, which EBB
   * doesn't track.
   */
  private pauseHook: (() => Promise<void>) | null = null;

  public constructor(port: SerialChannel, hardware: Hardware = "v3") {
    this.hardware = hardware;
    this.port = port;
    this.writer = this.port.writable.getWriter();
    this.commandQueue = [];

    // Read with a raw reader + manual decode (rather than pipeThrough/pipeTo) so
    // we own the lock on port.readable and can release it deterministically in
    // close(): close() cancels this reader, the loop ends and releases the lock,
    // then port.close() can proceed. pipeThrough hid the lock behind a second,
    // un-awaited pipe, which left the stream locked at close (visible across a
    // worker stream-transfer as "Cannot cancel a locked stream").
    this.reader = port.readable.getReader();
    const reader = this.reader;
    const decoder = new TextDecoder();
    let buffer = "";

    this.readableClosed = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split(/[\r\n]+/); // each command is on a different line
          buffer = parts.pop() || "";

          for (const part of parts) {
            if (part.trim() === "") continue; // empty line
            if (this.commandQueue.length) {
              if (part[0] === "!") {
                // error from EBB
                this.commandQueue.shift()?.reject(new Error(part));
                continue;
              }

              try {
                const d = this.commandQueue[0].next(part);
                if (d.done) {
                  this.commandQueue.shift()?.resolve(d.value);
                }
              } catch (e) {
                this.commandQueue.shift()?.reject(e as Error);
              }
            } else {
              console.log(`unexpected data: ${part}`);
            }
          }
        }
      } catch (error) {
        // Premature close (disconnect) or cancel from close(); the disconnect
        // handler / close() take it from here. Don't reject from this detached
        // loop (it would surface as an unhandled rejection).
        const e = error as { code?: string; name?: string };
        if (e.code !== "ERR_STREAM_PREMATURE_CLOSE" && e.name !== "AbortError") {
          console.log(`read loop ended: ${(error as Error).message}`);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
      }
    })();
  }

  private get stepMultiplier() {
    switch (this.microsteppingMode) {
      case MicrostepMode.FULL: return 1;
      case MicrostepMode.HALF: return 2;
      case MicrostepMode.QUARTER: return 4;
      case MicrostepMode.EIGHTH: return 8;
      case MicrostepMode.SIXTEENTH: return 16;
      default:
        throw new Error(`Invalid microstepping mode: ${this.microsteppingMode}`);
    } // biome-ignore format: compactness
  }

  public async close(): Promise<void> {
    // Put both streams into a closed/cancelled state before closing the port,
    // or port.close() throws on the still-locked streams — including across a
    // worker stream-transfer, where only a propagating state change (cancel /
    // abort), not a local releaseLock(), frees the stream for the other realm.
    // Cancel the reader (the read loop then ends and releases the read lock),
    // and abort the writer (the write side's analog of cancel).
    await this.reader.cancel().catch(() => {});
    await this.readableClosed.catch(() => {});
    await this.writer.abort().catch(() => {});
    try {
      this.writer.releaseLock();
    } catch {
      // already released / errored
    }
    await this.port.close();
  }

  public changeHardware(hardware: Hardware) {
    this.hardware = hardware;
  }

  private write(str: string): Promise<void> {
    if (process.env.DEBUG_SAXI_COMMANDS) {
      console.log(`writing: ${str}`);
    }
    const encoder = new TextEncoder();
    return this.writer.write(encoder.encode(str));
  }

  /** Send a raw command to the EBB and expect a single line in return, without an "OK" line to terminate. */
  public async query(cmd: EBBQuery): Promise<string> {
    try {
      return await this.run(function* (): Iterator<string, string, string> {
        this.write(`${cmd}\r`);
        const result = yield;
        return result;
      });
    } catch (err) {
      throw new Error(`Error in response to query '${cmd}': ${(err as Error).message}`);
    }
  }

  /** Send a raw command to the EBB and expect multiple lines in return, with an "OK" line to terminate. */
  public async queryM(cmd: EBBQueryM): Promise<string[]> {
    try {
      return await this.run(function* (): Iterator<string[], string[], string> {
        this.write(`${cmd}\r`);
        const result: string[] = [];
        while (true) {
          const line = yield;
          if (line === "OK") { break; } // biome-ignore format: compactness
          result.push(line);
        }
        return result;
      });
    } catch (err) {
      throw new Error(`Error in response to queryM '${cmd}': ${(err as Error).message}`);
    }
  }

  /** Send a raw command to the EBB and expect a single "OK" line in return. */
  public async command(cmd: EBBCommand): Promise<void> {
    try {
      return await this.run(function* (): Iterator<void, void, string> {
        this.write(`${cmd}\r`);
        const ok = yield;
        if (ok !== "OK") {
          throw new Error(`Expected OK, got ${ok}`);
        }
      });
    } catch (err) {
      throw new Error(`Error in response to command '${cmd}': ${(err as Error).message}`);
    }
  }

  /** The board's maximum motion FIFO depth (QU,2; firmware >= 3.0.0). */
  private async maxFifoDepth(): Promise<number> {
    try {
      const lines = await this.queryM("QU,2");
      const value = Number(lines[0]?.split(",").pop());
      if (Number.isFinite(value) && value >= 1) return value;
    } catch {
      // fall through to a conservative depth known to be supported
    }
    return 32;
  }

  /**
   * Deepen the EBB's motion FIFO (firmware >= 3.0.0).
   *
   * With the boot default of a 1-deep FIFO, any host stall longer than one
   * block (GC pause, OS scheduling hiccup) starves the steppers and the
   * carriage visibly stutters. A deeper FIFO keeps up to N commands buffered
   * on the board, so the machine glides through host stalls. By default the
   * FIFO is set as deep as the board supports; SAXI_FIFO_DEPTH=n overrides,
   * and SAXI_FIFO_DEPTH=1 restores the boot default (the setting persists on
   * the board until power-cycled, so an explicit 1 is the only reliable "off").
   */
  public async configureFifoDepth(): Promise<void> {
    try {
      const requested = Math.floor(Number(process.env.SAXI_FIFO_DEPTH || 0));
      if ((await this.firmwareVersionCompare(3, 0, 0)) < 0) {
        if (requested > 1) {
          console.log("[saxi] SAXI_FIFO_DEPTH ignored: firmware < 3.0.0 has a fixed 1-deep FIFO");
        }
        return;
      }
      const depth = requested >= 1 ? requested : await this.maxFifoDepth();
      await this.command(`CU,4,${depth}`);
      console.log(`[saxi] EBB motion FIFO depth set to ${depth}`);
    } catch (err) {
      console.log(`[saxi] failed to set FIFO depth: ${(err as Error).message}`);
    }
  }

  /** Reject all pending commands immediately **/
  public cancel(): void {
    while (this.commandQueue.length > 0) {
      this.commandQueue.shift()?.reject(new Error("Cancelled"));
    }
  }

  /**
   * Cooperatively stop the LM streaming loop (executeXYMotionWithLM) after the
   * current block, leaving the command/response stream in sync. Use this to
   * abort a plot mid-motion; cancel() rejects in-flight commands and desyncs.
   */
  public requestStop(): void {
    this.stopRequested = true;
  }

  /** Clear a prior requestStop() before starting a new plot. */
  public resetStop(): void {
    this.stopRequested = false;
  }

  /**
   * Cooperatively pause the LM streaming loop before the next block (so a pause
   * takes effect mid-motion, not just at motion boundaries). The loop runs the
   * registered pause hook, which drains the FIFO, lifts the pen, waits for
   * resume and lowers the pen — keeping the command/response stream in sync.
   */
  public requestPause(): void {
    this.pauseRequested = true;
  }

  /** Clear a pending pause request (e.g. before starting a new plot). */
  public clearPause(): void {
    this.pauseRequested = false;
  }

  /** Register the gate the LM streaming loop awaits between blocks when paused. */
  public setPauseHook(hook: (() => Promise<void>) | null): void {
    this.pauseHook = hook;
  }
  public async enableMotors(microsteppingMode: RunningMicrostepMode): Promise<void> {
    this.microsteppingMode = microsteppingMode;
    await this.command(`EM,${microsteppingMode},${microsteppingMode}`);
    // if the board supports SR, we should also enable the servo motors.
    if (await this.supportsSR()) await this.setServoPowerTimeout(0, true);
  }

  public async disableMotors(): Promise<void> {
    await this.command("EM,0,0");
    // if the board supports SR, we should also disable the servo motors.
    if (await this.supportsSR())
      // 60 seconds is the default boot-time servo power timeout.
      await this.setServoPowerTimeout(60000, false);
  }

  /**
   * Set the servo power timeout, in seconds. If a second parameter is
   * supplied, the servo will be immediately commanded into the given state (on
   * or off) depending on its value, in addition to setting the power-off
   * timeout duration.
   *
   * NB. this command is only available on firmware v2.6.0 and hardware of at
   * least version 2.5.0.
   */
  public async setServoPowerTimeout(timeout: number, power?: boolean) {
    const timeoutMs = (timeout * 1000) | 0;
    if (power != null) {
      const powerState: PowerState = power ? 1 : 0;
      await this.command(`SR,${timeoutMs},${powerState}`);
    } else {
      await this.command(`SR,${timeoutMs}`);
    }
  }

  // https://evil-mad.github.io/EggBot/ebb.html#S2 General RC Servo Output
  public async setPenHeight(height: number, rate: number, delay = 0): Promise<void> {
    const output_pin = this.hardware === "v3" ? 4 : 5;
    return await this.command(`S2,${height},${output_pin},${rate},${delay}`);
  }

  public lowlevelMove(
    stepsAxis1: number,
    initialStepsPerSecAxis1: number,
    finalStepsPerSecAxis1: number,
    stepsAxis2: number,
    initialStepsPerSecAxis2: number,
    finalStepsPerSecAxis2: number,
  ): Promise<void> {
    const [initialRate1, deltaR1] = this.axisRate(stepsAxis1, initialStepsPerSecAxis1, finalStepsPerSecAxis1);
    const [initialRate2, deltaR2] = this.axisRate(stepsAxis2, initialStepsPerSecAxis2, finalStepsPerSecAxis2);
    return this.command(`LM,${initialRate1},${stepsAxis1},${deltaR1},${initialRate2},${stepsAxis2},${deltaR2}`);
  }

  /**
   * Use the low-level move command "LM" to perform a constant-acceleration stepper move.
   *
   * Available with EBB firmware 2.5.3 and higher.
   *
   * @param xSteps Number of steps to move in the X direction
   * @param ySteps Number of steps to move in the Y direction
   * @param initialRate Initial step rate, in steps per second
   * @param finalRate Final step rate, in steps per second
   */
  public moveWithAcceleration(xSteps: number, ySteps: number, initialRate: number, finalRate: number): Promise<void> {
    if (!(xSteps !== 0 || ySteps !== 0)) {
      throw new Error("Must move on at least one axis");
    }
    if (!(initialRate >= 0 && finalRate >= 0)) {
      throw new Error(`Rates must be positive, were ${initialRate},${finalRate}`);
    }
    if (!(initialRate > 0 || finalRate > 0)) {
      throw new Error("Must have non-zero velocity during motion");
    }
    const stepsAxis1 = xSteps + ySteps;
    const stepsAxis2 = xSteps - ySteps;
    const norm = Math.sqrt(xSteps ** 2 + ySteps ** 2);
    const normX = xSteps / norm;
    const normY = ySteps / norm;
    const initialRateX = initialRate * normX;
    const initialRateY = initialRate * normY;
    const finalRateX = finalRate * normX;
    const finalRateY = finalRate * normY;
    const initialRateAxis1 = Math.abs(initialRateX + initialRateY);
    const initialRateAxis2 = Math.abs(initialRateX - initialRateY);
    const finalRateAxis1 = Math.abs(finalRateX + finalRateY);
    const finalRateAxis2 = Math.abs(finalRateX - finalRateY);
    return this.lowlevelMove(
      stepsAxis1,
      initialRateAxis1,
      finalRateAxis1,
      stepsAxis2,
      initialRateAxis2,
      finalRateAxis2,
    );
  }

  /**
   * Use the high-level move command "XM" to perform a constant-velocity stepper move.
   *
   * @param duration Duration of the move, in seconds
   * @param x Number of microsteps to move in the X direction
   * @param y Number of microsteps to move in the Y direction
   */
  public moveAtConstantRate(duration: number, x: number, y: number): Promise<void> {
    return this.command(`XM,${Math.floor(duration * 1000)},${x},${y}`);
  }

  public async waitUntilMotorsIdle(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const [, commandStatus, _motor1Status, _motor2Status, fifoStatus] = (await this.query("QM")).split(",");
      if (commandStatus === "0" && fifoStatus === "0") {
        break;
      }
    }
  }

  public async executeBlockWithLM(block: Block): Promise<void> {
    const [errX, stepsX] = modf((block.p2.x - block.p1.x) * this.stepMultiplier + this.error.x);
    const [errY, stepsY] = modf((block.p2.y - block.p1.y) * this.stepMultiplier + this.error.y);
    this.error.x = errX;
    this.error.y = errY;
    if (stepsX !== 0 || stepsY !== 0) {
      await this.moveWithAcceleration(
        stepsX,
        stepsY,
        block.vInitial * this.stepMultiplier,
        block.vFinal * this.stepMultiplier,
      );
    }
  }
  /**
   * Execute a constant-acceleration motion plan using the low-level LM command.
   *
   * Note that the LM command is only available starting from EBB firmware version 2.5.3.
   */
  public async executeXYMotionWithLM(plan: XYMotion): Promise<void> {
    const trace = BlockTimingTrace.maybeStart();
    let prevOkAt = trace ? performance.now() : 0;
    let index = 0;
    for (const block of plan.blocks) {
      // Cooperative stop: bail out between blocks (after the in-flight command's
      // OK has been consumed) so response matching stays in sync — unlike
      // cancel(), which rejects mid-command and desyncs the next reply.
      if (this.stopRequested) return;
      // Cooperative pause: same between-block checkpoint, but the host gate
      // waits for resume (and manages the pen) instead of bailing.
      if (this.pauseRequested) {
        this.pauseRequested = false;
        if (this.pauseHook) await this.pauseHook();
        if (trace) prevOkAt = performance.now(); // don't count the pause as a host gap
      }
      if (trace) {
        // gap = host-side time between the previous block's OK and sending this
        // one (where a GC / event-loop stall would starve a 1-deep FIFO);
        // rtt = the LM command's send->OK round-trip (board + serial bound,
        // and at FIFO depth 1 it also includes waiting for the slot to free).
        const sendAt = performance.now();
        const gap = sendAt - prevOkAt;
        await this.executeBlockWithLM(block);
        const okAt = performance.now();
        trace.record(index, block.duration * 1000, okAt - sendAt, gap);
        prevOkAt = okAt;
      } else {
        await this.executeBlockWithLM(block);
      }
      index += 1;
    }
    trace?.summarize();
  }

  /**
   * Execute a constant-acceleration motion plan using the high-level XM command.
   *
   * This is less accurate than using LM, since acceleration will only be adjusted every timestepMs milliseconds,
   * where LM can adjust the acceleration at a much higher rate, as it executes on-board the EBB.
   */
  public async executeXYMotionWithXM(plan: XYMotion, timestepMs = 15): Promise<void> {
    const timestepSec = timestepMs / 1000;
    let t = 0;
    while (t < plan.duration()) {
      const i1 = plan.instant(t);
      const i2 = plan.instant(t + timestepSec);
      const d = vsub(i2.p, i1.p);
      const [ex, sx] = modf(d.x * this.stepMultiplier + this.error.x);
      const [ey, sy] = modf(d.y * this.stepMultiplier + this.error.y);
      this.error.x = ex;
      this.error.y = ey;
      await this.moveAtConstantRate(timestepSec, sx, sy);
      t += timestepSec;
    }
  }

  /** Execute a constant-acceleration motion plan, starting and ending with zero velocity. */
  public async executeXYMotion(plan: XYMotion): Promise<void> {
    if (await this.supportsLM()) {
      await this.executeXYMotionWithLM(plan);
    } else {
      await this.executeXYMotionWithXM(plan);
    }
  }

  public executePenMotion(pm: PenMotion): Promise<void> {
    // rate is in units of clocks per 24ms.
    // so to fit the entire motion in |pm.duration|,
    // dur = diff / rate
    // [time] = [clocks] / ([clocks]/[time])
    // [time] = [clocks] * [clocks]^-1 * [time]
    // [time] = [time]
    // ✔
    // so rate = diff / dur
    // dur is in [sec]
    // but rate needs to be in [clocks] / [24ms]
    // duration in units of 24ms is duration * [24ms] / [1s]
    const diff = Math.abs(pm.finalPos - pm.initialPos);
    const durMs = pm.duration() * 1000;
    const rate = Math.round((diff * 24) / durMs);
    return this.setPenHeight(pm.finalPos, rate, durMs);
  }

  public executeMotion(m: Motion): Promise<void> {
    if (m instanceof XYMotion) {
      return this.executeXYMotion(m);
    }
    if (m instanceof PenMotion) {
      return this.executePenMotion(m);
    }
    throw new Error(`Unknown motion type: ${m.constructor.name}`);
  }

  public async executePlan(plan: Plan, microsteppingMode: RunningMicrostepMode = MicrostepMode.EIGHTH): Promise<void> {
    await this.configureFifoDepth();
    await this.enableMotors(microsteppingMode);

    for (const m of plan.motions) {
      await this.executeMotion(m);
    }

    await this.waitUntilMotorsIdle();
    await this.disableMotors();
  }

  /**
   * Query voltages for board & steppers. Useful to check whether stepper power is plugged in.
   *
   * @return Tuple of (RA0_VOLTAGE, V+_VOLTAGE, VIN_VOLTAGE)
   */
  public async queryVoltages(): Promise<[number, number, number]> {
    const [ra0Voltage, vPlusVoltage] = (await this.queryM("QC"))[0].split(/,/).map(Number);
    return [
      ra0Voltage / 1023.0 * 3.3,
      vPlusVoltage / 1023.0 * 3.3,
      vPlusVoltage / 1023.0 * 3.3 * 9.2 + 0.3
    ]; // biome-ignore format: readability
  }

  /**
   * Query the firmware version running on the EBB.
   *
   * @return The version string, e.g. "EBBv13_and_above EB Firmware Version 2.5.3"
   */
  public async firmwareVersion(): Promise<string> {
    return await this.query("V");
  }

  /**
   * @return The firmware version as a parsed version triple, e.g. [2, 5, 3]
   */
  public async firmwareVersionNumber(): Promise<[number, number, number]> {
    if (this.cachedFirmwareVersion === undefined) {
      const versionString = await this.firmwareVersion();
      const versionWords = versionString.split(" ");
      const [major, minor, patch] = versionWords[versionWords.length - 1].split(".").map(Number);
      this.cachedFirmwareVersion = [major, minor, patch];
    }
    return this.cachedFirmwareVersion;
  }

  /**
   * Compare the firmware version of the EBB with the given version.
   *
   * @return -1 if the firmware is older than the given version, 0 if it's
   * identical, and 1 if it's newer.
   */
  public async firmwareVersionCompare(major: number, minor: number, patch: number): Promise<number> {
    const [fwMajor, fwMinor, fwPatch] = await this.firmwareVersionNumber();
    if (fwMajor < major) return -1;
    if (fwMajor > major) return 1;
    if (fwMinor < minor) return -1;
    if (fwMinor > minor) return 1;
    if (fwPatch < patch) return -1;
    if (fwPatch > patch) return 1;
    return 0;
  }

  public async areSteppersPowered(): Promise<boolean> {
    const [, , vInVoltage] = await this.queryVoltages();
    return vInVoltage > 6;
  }

  public async queryButton(): Promise<boolean> {
    return (await this.queryM("QB"))[0] === "1";
  }

  /**
   * @return true iff the EBB firmware supports the LM command.
   */
  public async supportsLM(): Promise<boolean> {
    return (await this.firmwareVersionCompare(2, 5, 3)) >= 0;
  }

  /**
   * @return true iff the EBB firmware supports the SR command.
   */
  public async supportsSR(): Promise<boolean> {
    return (await this.firmwareVersionCompare(2, 6, 0)) >= 0;
  }

  /**
   * Helper method for computing axis rates for the LM command.
   *
   * See http://evil-mad.github.io/EggBot/ebb.html#LM
   *
   * @param steps Number of steps being taken
   * @param initialStepsPerSec Initial movement rate, in steps per second
   * @param finalStepsPerSec Final movement rate, in steps per second
   * @return A tuple of (initialAxisRate, deltaR) that can be passed to the LM command
   */
  private axisRate(steps: number, initialStepsPerSec: number, finalStepsPerSec: number): [number, number] {
    if (steps === 0) return [0, 0];
    const initialRate = Math.round(initialStepsPerSec * (0x80000000 / 25000));
    const finalRate = Math.round(finalStepsPerSec * (0x80000000 / 25000));
    const moveTime = (2 * Math.abs(steps)) / (initialStepsPerSec + finalStepsPerSec);
    const deltaR = Math.round((finalRate - initialRate) / (moveTime * 25000));
    return [initialRate, deltaR];
  }

  private run<T>(g: (this: EBB) => Iterator<T>): Promise<T> {
    const cmd = g.call(this);
    const d = cmd.next();
    if (d.done) {
      return Promise.resolve(d.value);
    }
    this.commandQueue.push(cmd);
    return new Promise((resolve, reject) => {
      cmd.resolve = resolve;
      cmd.reject = reject;
    });
  }
}
