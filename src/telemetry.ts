/**
 * Lightweight timing telemetry for diagnosing stuttery plots.
 *
 * Each planned motion block is sent to the EBB as one serial command, and the
 * EBB's motion FIFO is only one command deep (firmware 2.x; 3.x boots the same
 * way). The machine moves smoothly only if every command's send->OK cycle
 * completes faster than the previous block executes; otherwise the steppers
 * run dry between commands and the plot stutters. This module measures exactly
 * that.
 *
 * Enabled via environment variables (see EBB constructor):
 *   SAXI_TELEMETRY=1       per-motion + end-of-plot timing summaries
 *   SAXI_TELEMETRY_QM=200  additionally query motor/FIFO status from the
 *                          machine every N blocks (adds one extra serial
 *                          round-trip per sample, so it slightly perturbs
 *                          the thing it measures)
 */

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(1)}ms`;
}

/** Cycles longer than planned by more than this margin count as stalls. */
const STALL_MARGIN_MS = 2;

/** Emit a running progress line every this many blocks within a motion. */
const PROGRESS_INTERVAL = 5000;

/** Individually log any command cycle that overruns its block by this much. */
const SLOW_EVENT_MS = 100;

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

export class PlotTelemetry {
  /** Sample QM (motor/FIFO status) every this many blocks; 0 = off. */
  public qmInterval: number;

  /**
   * Motion FIFO depth configured on the board (set by EBB.configureFifoDepth).
   * With a deep FIFO, cycles longer than planned mostly mean healthy
   * backpressure (waiting for queue space), not starvation, so the stall
   * numbers must be read differently.
   */
  public fifoDepth = 1;

  private motionIdx = 0;
  private plannedMs: number[] = [];
  private cycleMs: number[] = [];
  private writeMs: number[] = [];

  // Totals are accumulated per-block (not per-motion) so that a cancelled
  // plot still reports everything that was measured up to the cancel.
  private totalBlocks = 0;
  private totalPlannedMs = 0;
  private totalCycleMs = 0;
  private totalStallMs = 0;
  private totalStallBlocks = 0;

  private qmSamples = 0;
  private qmFifoEmpty = 0;
  private qmIdle = 0;

  private lagTimer: ReturnType<typeof setInterval> | null = null;
  private gcObserver: PerformanceObserver | null = null;
  private slowEventsSuppressed = 0;
  private lastSlowEventLog = 0;

  constructor(qmInterval = 0) {
    this.qmInterval = qmInterval > 0 ? Math.floor(qmInterval) : 0;
  }

  /**
   * Start host-side probes that run independently of the serial traffic:
   * an event-loop lag monitor and (in Node) a GC pause observer. Together
   * with the per-block timings these tell apart "host froze" (lag + GC lines
   * coincide with slow blocks) from "serial link is slow" (slow blocks alone).
   */
  private startProbes(): void {
    if (this.lagTimer == null) {
      let last = performance.now();
      this.lagTimer = setInterval(() => {
        const now = performance.now();
        const lag = now - last - 50;
        last = now;
        if (lag > 50) {
          console.log(`[saxi-telemetry] ${ts()} event-loop stall: ${lag.toFixed(0)}ms`);
        }
      }, 50);
      // Don't keep the process alive for the probe (Node-only API).
      (this.lagTimer as { unref?: () => void }).unref?.();
    }
    if (this.gcObserver == null && typeof PerformanceObserver !== "undefined") {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 20) {
              console.log(`[saxi-telemetry] ${ts()} GC pause: ${entry.duration.toFixed(0)}ms`);
            }
          }
        });
        observer.observe({ entryTypes: ["gc"] });
        this.gcObserver = observer;
      } catch {
        // 'gc' entries unsupported (e.g. browsers); skip.
        this.gcObserver = null;
      }
    }
  }

  /** Forget everything; call at the start of each plot. */
  public reset(): void {
    this.motionIdx = 0;
    this.plannedMs = [];
    this.cycleMs = [];
    this.writeMs = [];
    this.totalBlocks = 0;
    this.totalPlannedMs = 0;
    this.totalCycleMs = 0;
    this.totalStallMs = 0;
    this.totalStallBlocks = 0;
    this.qmSamples = 0;
    this.qmFifoEmpty = 0;
    this.qmIdle = 0;
    this.slowEventsSuppressed = 0;
    this.lastSlowEventLog = 0;
    this.startProbes();
    console.log("[saxi-telemetry] enabled (stall = command cycle exceeding planned block duration)");
  }

  public beginMotion(): void {
    this.plannedMs = [];
    this.cycleMs = [];
  }

  /**
   * Record one executed block: its planned duration vs the wall-clock time the
   * full send->OK command cycle took.
   */
  public recordBlock(plannedDurationMs: number, commandCycleMs: number): void {
    this.plannedMs.push(plannedDurationMs);
    this.cycleMs.push(commandCycleMs);
    this.totalBlocks++;
    this.totalPlannedMs += plannedDurationMs;
    this.totalCycleMs += commandCycleMs;
    const over = commandCycleMs - plannedDurationMs;
    if (over > STALL_MARGIN_MS) {
      this.totalStallMs += over;
      this.totalStallBlocks++;
    }
    if (over > SLOW_EVENT_MS) {
      // Rate-limit to one line per second; aggregate the rest.
      const now = performance.now();
      if (now - this.lastSlowEventLog > 1000) {
        const suppressed = this.slowEventsSuppressed > 0 ? ` (+${this.slowEventsSuppressed} more in the last second)` : "";
        console.log(
          `[saxi-telemetry] ${ts()} slow block: cycle ${fmtMs(commandCycleMs)} vs planned ${fmtMs(plannedDurationMs)} ` +
            `at motion ${this.motionIdx + 1} block ${this.cycleMs.length}${suppressed}`,
        );
        this.lastSlowEventLog = now;
        this.slowEventsSuppressed = 0;
      } else {
        this.slowEventsSuppressed++;
      }
    }
    if (this.cycleMs.length % PROGRESS_INTERVAL === 0) {
      console.log(
        `[saxi-telemetry] motion ${this.motionIdx + 1} progress: ${this.cycleMs.length} blocks | ` +
          `plot-wide stalled blocks so far: ${this.totalStallBlocks} totaling ${fmtMs(this.totalStallMs)}`,
      );
    }
  }

  /** Record how long a serial write took to be accepted by the OS driver. */
  public recordWrite(ms: number): void {
    this.writeMs.push(ms);
  }

  /**
   * Record a QM response sampled mid-motion. At that point the machine should
   * be busy (command executing, FIFO occupied); an idle response is
   * machine-side proof of a buffer underrun, and "executing with empty FIFO"
   * means the buffer is on the verge of running dry.
   */
  public recordQM(response: string, blockIdx: number): void {
    const [, commandStatus, , , fifoStatus] = response.split(",");
    this.qmSamples++;
    if (fifoStatus === "0") this.qmFifoEmpty++;
    if (commandStatus === "0") {
      this.qmIdle++;
      console.log(`[saxi-telemetry] QM @ motion ${this.motionIdx + 1} block ${blockIdx}: machine IDLE mid-path (underrun confirmed)`);
    }
  }

  /** Print stats for the current motion; safe to call after a cancel. */
  public endMotion(): void {
    const n = this.cycleMs.length;
    this.motionIdx++;
    // Pen-up travel moves are also XY motions; only report on substantial ones.
    if (n < 10) return;

    let planned = 0;
    let cycle = 0;
    let stallMs = 0;
    let stallBlocks = 0;
    for (let i = 0; i < n; i++) {
      planned += this.plannedMs[i];
      cycle += this.cycleMs[i];
      const over = this.cycleMs[i] - this.plannedMs[i];
      if (over > STALL_MARGIN_MS) {
        stallMs += over;
        stallBlocks++;
      }
    }

    const sorted = [...this.cycleMs].sort((a, b) => a - b);
    console.log(
      `[saxi-telemetry] motion ${this.motionIdx}: ${n} blocks | ` +
        `planned ${fmtMs(planned)}, actual ${fmtMs(cycle)} (${cycle >= planned ? "+" : ""}${fmtMs(cycle - planned)}) | ` +
        `stalled blocks: ${stallBlocks} (${((stallBlocks / n) * 100).toFixed(1)}%) totaling ${fmtMs(stallMs)} | ` +
        `cycle p50 ${fmtMs(percentile(sorted, 50))} p95 ${fmtMs(percentile(sorted, 95))} max ${fmtMs(sorted[n - 1])}`,
    );
  }

  /** Print the whole-plot summary; call once plotting finishes or is cancelled. */
  public logSummary(): void {
    if (this.totalBlocks === 0) return;
    const behind = this.totalCycleMs - this.totalPlannedMs;
    console.log(
      `[saxi-telemetry] PLOT SUMMARY: ${this.totalBlocks} blocks | ` +
        `planned ${fmtMs(this.totalPlannedMs)}, actual ${fmtMs(this.totalCycleMs)} ` +
        `(${behind >= 0 ? "+" : ""}${((behind / Math.max(1, this.totalPlannedMs)) * 100).toFixed(1)}% vs plan) | ` +
        `stalled blocks: ${this.totalStallBlocks} (${((this.totalStallBlocks / this.totalBlocks) * 100).toFixed(1)}%), ` +
        `total stall time ${fmtMs(this.totalStallMs)}`,
    );
    if (this.writeMs.length > 0) {
      const sorted = [...this.writeMs].sort((a, b) => a - b);
      console.log(
        `[saxi-telemetry] serial writes: ${sorted.length} | ` +
          `p50 ${fmtMs(percentile(sorted, 50))} p95 ${fmtMs(percentile(sorted, 95))} max ${fmtMs(sorted[sorted.length - 1])}`,
      );
    }
    if (this.qmSamples > 0) {
      console.log(
        `[saxi-telemetry] QM samples: ${this.qmSamples} | ` +
          `FIFO empty: ${this.qmFifoEmpty} | machine idle mid-path: ${this.qmIdle}`,
      );
    }
    if (this.fifoDepth > 1) {
      console.log(
        `[saxi-telemetry] note: FIFO depth is ${this.fifoDepth}, so stalled-block counts mostly reflect ` +
          "healthy backpressure pacing; judge smoothness by actual-vs-plan, the FIFO LED, and QM idle counts.",
      );
    } else if (this.totalStallMs > 1000) {
      console.log(
        "[saxi-telemetry] diagnosis hint: significant stall time means command cycles can't keep up with " +
          "block durations -> the EBB's 1-deep FIFO runs dry between commands (visible as stutter). " +
          "Shorter blocks (denser SVG paths) make this worse.",
      );
    }
  }
}
