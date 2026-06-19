import type { Hardware } from "./ebb";
import { Plan } from "./planning.js";
import type { HostEvent } from "./serial-worker-rpc.js";

export interface DeviceInfo {
  path: string;
  hardware: Hardware;
  svgIoEnabled: boolean;
}

/**
 * Driver interface for the Axi machine.
 */
export abstract class BaseDriver {
  public onprogress: (motionIdx: number) => void = () => {};
  public oncancelled: () => void = () => {};
  public onfinished: () => void = () => {};
  public ondevinfo: (devInfo: DeviceInfo) => void = () => {};
  public onpause: (paused: boolean) => void = () => {};
  public connected = false;
  /**
   * Called when plan loaded
   */
  public onplan: (plan: Plan) => void = () => {};

  abstract plot(plan: Plan): void;
  abstract cancel(): void;
  abstract pause(): void;
  abstract resume(): void;
  abstract setPenHeight(height: number, rate: number): void;
  abstract limp(): void;
  abstract changeHardware(hardware: Hardware): void;
  abstract name(): string;
  abstract close(): Promise<void>;
}

/**
 * WebSerial driver for the EBB. Connects directly to the Axi machine in the
 * browser (serverless config, IS_WEB set). The EBB and the whole plot loop run
 * on a dedicated Web Worker (serial-worker.js): the UI thread only does the
 * requestPort() picker (navigator.serial requires a Window gesture), then the
 * worker re-acquires that port via getPorts() and opens it, so the serial byte
 * pipe lives on the worker thread. From then on the UI thread only posts
 * commands and receives lifecycle events — so React/GC on the UI thread can't
 * stall the serial loop (not even its byte I/O, which transferring the streams
 * left on the main thread).
 */
export class WebSerialDriver extends BaseDriver {
  public hardware: Hardware;
  private _name: string;
  private worker: Worker;
  /** Resolves when the worker has opened the port; rejects if it couldn't. */
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  private settled = false;

  public static async connect(port?: SerialPort, hardware: Hardware = "v3") {
    // requestPort() needs a user gesture and is Window-only, so the main thread
    // does just the picker; the worker re-acquires the port via getPorts() and
    // opens it, keeping the serial byte pipe on the worker thread.
    if (!port)
      // biome-ignore lint/style/noParameterAssign: trivial
      port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x04d8, usbProductId: 0xfd92 }] });
    const { usbVendorId, usbProductId } = port.getInfo();

    const vendorId = usbVendorId?.toString(16).padStart(4, "0");
    const productId = usbProductId?.toString(16).padStart(4, "0");
    const name = `${vendorId}:${productId}`;

    const driver = new WebSerialDriver(name, hardware, usbVendorId, usbProductId);
    await driver.ready; // wait for the worker to open the port (throws on failure)
    driver.connected = true;

    return driver;
  }

  public name(): string {
    return this._name;
  }

  private constructor(name: string, hardware: Hardware, usbVendorId?: number, usbProductId?: number) {
    super();
    this._name = name;
    this.hardware = hardware;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker("serial-worker.js");
    this.worker.addEventListener("message", (e: MessageEvent<HostEvent>) => this.onEvent(e.data));
    this.worker.addEventListener("error", (e) => {
      console.error(`[serial-worker] failed to load/run: ${e.message}`);
      this.settle(() => this.rejectReady(new Error(e.message || "serial worker failed to start")));
    });
    this.worker.addEventListener("messageerror", (e) => console.error("[serial-worker] message clone error", e));
    // The worker opens the port itself; we only tell it which device to find.
    this.worker.postMessage({ kind: "init", hardware, usbVendorId, usbProductId });
  }

  /** Resolve/reject `ready` exactly once. */
  private settle(action: () => void): void {
    if (this.settled) return;
    this.settled = true;
    action();
  }

  private onEvent(event: HostEvent): void {
    switch (event.kind) {
      case "ready":
        this.settle(() => this.resolveReady());
        break;
      case "progress":
        this.onprogress(event.motionIdx);
        break;
      case "paused":
        this.onpause(event.paused);
        break;
      case "finished":
        this.onfinished();
        break;
      case "cancelled":
        this.oncancelled();
        break;
      case "error":
        console.error(`[serial-worker] ${event.message}`);
        // A failure before "ready" means the port never opened — fail connect().
        this.settle(() => this.rejectReady(new Error(event.message)));
        break;
      case "disconnected":
        this.handleDisconnection();
        break;
    }
  }

  private handleDisconnection(): void {
    console.log("WebSerial device disconnected");
    this.connected = false;
  }

  public async close(): Promise<void> {
    this.handleDisconnection();
    // The worker owns the port now, so it tears down the EBB and closes the
    // port itself — no main-thread close retry needed.
    this.worker.postMessage({ kind: "close" });
  }

  public plot(plan: Plan): void {
    this.worker.postMessage({ kind: "plot", plan: plan.serialize() });
  }

  public cancel(): void {
    this.worker.postMessage({ kind: "cancel" });
  }

  public pause(): void {
    this.worker.postMessage({ kind: "pause" });
  }

  public resume(): void {
    this.worker.postMessage({ kind: "resume" });
  }

  public setPenHeight(height: number, rate: number): void {
    this.worker.postMessage({ kind: "setPenHeight", height, rate });
  }

  public limp(): void {
    this.worker.postMessage({ kind: "limp" });
  }

  public changeHardware(hardware: Hardware): void {
    this.hardware = hardware;
    this.worker.postMessage({ kind: "changeHardware", hardware });
    this.ondevinfo({
      path: this._name,
      hardware,
      svgIoEnabled: false, // WebSerial doesn't support SVG I/O
    });
  }
}

/**
 * Saxi Serial driver for the EBB. Implement interface by connecting to the Axi
 * through the saxi web server, which handles the control. Used in the default
 * configuration (IS_WEB is unset).
 */
export class SaxiDriver extends BaseDriver {
  private socket: WebSocket;
  private pingInterval: number | undefined;
  svgioEnabled: (enabled: boolean) => void;

  public name() {
    return "Saxi Server";
  }

  public close() {
    this.socket.close();
    return Promise.resolve();
  }

  public static async connect(): Promise<SaxiDriver> {
    const d = new SaxiDriver();
    await d.connect();
    return d;
  }

  public async connect() {
    const websocketProtocol = document.location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${websocketProtocol}://${document.location.host}/chat`);

    this.socket.addEventListener("open", () => {
      console.log("Connected to EBB server.");
      this.connected = true;
      this.pingInterval = window.setInterval(() => this.ping(), 30000);
    });
    this.socket.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      switch (msg.c) {
        case "pong": {
          // nothing
        } break;
        case "progress": {
          this.onprogress(msg.p.motionIdx);
        } break;
        case "cancelled": {
          this.oncancelled();
        } break;
        case "finished": {
          this.onfinished();
        } break;
        case "dev": {
          this.ondevinfo(msg.p);
        } break;
        case "svgio-enabled": {
          this.svgioEnabled(msg.p);
        } break;
        case "pause": {
          this.onpause(msg.p.paused);
        } break;
        case "plan": {
          this.onplan(Plan.deserialize(msg.p.plan));
        } break;
        default: {
          console.log("Unknown message from server:", msg);
        } break;
      }
    }); // biome-ignore format: compactness
    this.socket.addEventListener("error", () => {
      // TODO: something
    });
    this.socket.addEventListener("close", () => {
      console.log("Disconnected from EBB server, reconnecting in 5 seconds.");
      window.clearInterval(this.pingInterval);
      this.pingInterval = undefined;
      this.connected = false;
      setTimeout(() => void this.connect(), 5000);
    });
  }

  public plot(plan: Plan) {
    fetch("/plot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan.serialize()),
    });
  }

  public cancel() {
    fetch("/cancel", { method: "POST" });
  }

  public pause() {
    fetch("/pause", { method: "POST" });
  }

  public resume() {
    fetch("/resume", { method: "POST" });
  }

  public send(msg: object) {
    if (!this.connected) {
      throw new Error(`Can't send message: not connected`);
    }
    this.socket.send(JSON.stringify(msg));
  }

  public setPenHeight(height: number, rate: number) {
    this.send({ c: "setPenHeight", p: { height, rate } });
  }

  public limp() {
    this.send({ c: "limp" });
  }
  public changeHardware(hardware: Hardware) {
    this.send({ c: "changeHardware", p: { hardware } });
  }
  public ping() {
    this.send({ c: "ping" });
  }
}
