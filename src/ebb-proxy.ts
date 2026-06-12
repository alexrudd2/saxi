/**
 * Main-thread proxy for the serial worker.
 *
 * Mirrors the subset of the EBB API the web server uses, forwarding each call
 * to the worker as an `{id, method, args}` message and resolving on the
 * matching reply. The server keeps its existing shape; `ebb` just becomes this
 * proxy. The streaming loop that must not be interrupted lives behind it, in
 * the worker.
 *
 * Transport is a real worker_thread in production and an in-process host under
 * vitest (so the serial-port mock and its shared command log keep working
 * without a thread boundary).
 */
import { EventEmitter } from "node:events";
import type { Hardware } from "./ebb.js";
import type { EbbHostOptions, EbbMethod, MainToWorker, WorkerToMain } from "./ebb-rpc.js";
import type { Motion } from "./planning.js";

interface Transport {
  postMessage(msg: MainToWorker): void;
  terminate(): Promise<void>;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class EbbProxy extends EventEmitter {
  private transport: Transport | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  /** Latest device state, kept in sync from the worker's `dev` events. */
  public connected = false;
  public devicePath: string | null = null;
  public hardware: Hardware;

  constructor(hardware: Hardware) {
    super();
    this.hardware = hardware;
  }

  /** Wire up the transport (called by createEbbProxy once it is built). */
  public attachTransport(transport: Transport): void {
    this.transport = transport;
  }

  /** Handle a message coming back from the worker/host. */
  public receive(msg: WorkerToMain): void {
    switch (msg.kind) {
      case "result": {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.resolve(msg.value);
        break;
      }
      case "error": {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.reject(new Error(msg.error));
        break;
      }
      case "dev": {
        this.connected = msg.connected;
        this.devicePath = msg.path;
        this.hardware = msg.hardware;
        this.emit("dev");
        break;
      }
    }
  }

  private call(method: EbbMethod, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.transport) {
        reject(new Error("EBB proxy transport not attached"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.transport.postMessage({ kind: "call", id, method, args });
    });
  }

  // --- EBB API surface used by the web server ---

  public executeMotion(motion: Motion): Promise<void> {
    return this.call("executeMotion", motion.serialize()) as Promise<void>;
  }
  public setPenHeight(height: number, rate: number, delay?: number): Promise<void> {
    return this.call("setPenHeight", height, rate, delay) as Promise<void>;
  }
  public setServoPowerTimeout(timeout: number, power?: boolean): Promise<void> {
    return this.call("setServoPowerTimeout", timeout, power) as Promise<void>;
  }
  public supportsSR(): Promise<boolean> {
    return this.call("supportsSR") as Promise<boolean>;
  }
  public enableMotors(microsteppingMode: number): Promise<void> {
    return this.call("enableMotors", microsteppingMode) as Promise<void>;
  }
  public disableMotors(): Promise<void> {
    return this.call("disableMotors") as Promise<void>;
  }
  public setFifoLedIndicator(on: boolean): Promise<void> {
    return this.call("setFifoLedIndicator", on) as Promise<void>;
  }
  public configureFifoDepth(): Promise<void> {
    return this.call("configureFifoDepth") as Promise<void>;
  }
  public waitUntilMotorsIdle(): Promise<void> {
    return this.call("waitUntilMotorsIdle") as Promise<void>;
  }
  public command(cmd: string): Promise<void> {
    return this.call("command", cmd) as Promise<void>;
  }
  public resetTelemetry(): Promise<void> {
    return this.call("resetTelemetry") as Promise<void>;
  }
  public logTelemetrySummary(): Promise<void> {
    return this.call("logTelemetrySummary") as Promise<void>;
  }

  /** Synchronous, like EBB.changeHardware: update the cache, push to the worker. */
  public changeHardware(hardware: Hardware): void {
    this.hardware = hardware;
    this.call("changeHardware", hardware).catch(() => {});
  }

  /** Out-of-band cancel: applied immediately in the worker, ahead of any queue. */
  public cancel(): void {
    this.transport?.postMessage({ kind: "cancel" });
  }

  public async terminate(): Promise<void> {
    await this.transport?.terminate();
  }
}

/**
 * Build a proxy and its transport. Under vitest the host runs in-process so the
 * serial-port mock applies; otherwise the host runs in a real worker_thread.
 */
export async function createEbbProxy(options: EbbHostOptions): Promise<EbbProxy> {
  const proxy = new EbbProxy(options.hardware);

  if (process.env.VITEST) {
    const { createEbbHost } = await import("./ebb-worker.js");
    const host = createEbbHost(options, (msg) => proxy.receive(msg));
    proxy.attachTransport({
      postMessage: (msg) => host.handleMessage(msg),
      terminate: () => host.terminate(),
    });
  } else {
    const { Worker } = await import("node:worker_threads");
    const worker = new Worker(new URL("./ebb-worker.js", import.meta.url), { workerData: options });
    let terminating = false;
    worker.on("message", (msg: WorkerToMain) => proxy.receive(msg));
    worker.on("error", (e) => console.error(`[ebb-worker] error: ${e.message}`));
    worker.on("exit", (code) => {
      if (code !== 0 && !terminating) console.error(`[ebb-worker] exited with code ${code}`);
    });
    proxy.attachTransport({
      postMessage: (msg) => worker.postMessage(msg),
      terminate: async () => {
        terminating = true;
        await worker.terminate();
      },
    });
  }

  return proxy;
}
