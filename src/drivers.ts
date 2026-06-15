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
 * on a dedicated Web Worker (serial-worker.js): the port is opened here on the
 * UI thread (navigator.serial requires it), its streams are transferred into
 * the worker, and from then on the UI thread only posts commands and receives
 * lifecycle events — so React/GC on the UI thread can't stall the serial loop.
 */
export class WebSerialDriver extends BaseDriver {
  public hardware: Hardware;
  private _name: string;
  private port: SerialPort;
  private worker: Worker;
  private _disconnectHandler: ((event: Event) => void) | null = null;

  public static async connect(port?: SerialPort, hardware: Hardware = "v3") {
    if (!port)
      // biome-ignore lint/style/noParameterAssign: trivial
      port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x04d8, usbProductId: 0xfd92 }] });
    // baudRate ref: https://github.com/evil-mad/plotink/blob/a45739b7d41b74d35c1e933c18949ed44c72de0e/plotink/ebb_serial.py#L281
    // (doesn't specify baud rate)
    // and https://pyserial.readthedocs.io/en/latest/pyserial_api.html#serial.Serial.__init__
    // (pyserial defaults to 9600)
    await port.open({ baudRate: 9600 });
    const { usbVendorId, usbProductId } = port.getInfo();

    const vendorId = usbVendorId?.toString(16).padStart(4, "0");
    const productId = usbProductId?.toString(16).padStart(4, "0");
    const name = `${vendorId}:${productId}`;

    const driver = new WebSerialDriver(port, name, hardware);
    driver._disconnectHandler = (event: Event) => {
      if (event.target === port) {
        driver.handleDisconnection();
      }
    };
    navigator.serial.addEventListener("disconnect", driver._disconnectHandler);
    driver.connected = true;

    return driver;
  }

  public name(): string {
    return this._name;
  }

  private constructor(port: SerialPort, name: string, hardware: Hardware) {
    super();
    this.port = port;
    this._name = name;
    this.hardware = hardware;
    this.worker = new Worker("serial-worker.js");
    this.worker.addEventListener("message", (e: MessageEvent<HostEvent>) => this.onEvent(e.data));
    // Hand the port's streams to the worker; from here it owns the EBB.
    this.worker.postMessage({ kind: "init", readable: port.readable, writable: port.writable, hardware }, [
      port.readable,
      port.writable,
    ]);
  }

  private onEvent(event: HostEvent): void {
    switch (event.kind) {
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
        break;
      case "closePort":
        void this.closePort();
        break;
    }
  }

  private handleDisconnection(): void {
    console.log("WebSerial device disconnected");
    this.connected = false;
  }

  /**
   * The worker released its locks on the transferred streams and asked us to
   * close the port. The unlock takes a moment to cross the thread boundary, so
   * retry until close() is accepted.
   */
  private async closePort(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      try {
        await this.port.close();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  public async close(): Promise<void> {
    this.handleDisconnection();
    if (this._disconnectHandler) {
      navigator.serial.removeEventListener("disconnect", this._disconnectHandler);
    }
    this.worker.postMessage({ kind: "close" }); // worker tears down the EBB, then emits closePort
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
