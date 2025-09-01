
import { EBB, type Hardware } from "./ebb";
import { Device, PenMotion, Plan } from "./planning.js";

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
  abstract name(): string;
  abstract close(): Promise<void>;
}

/**
 * WebSerial driver for the EBB. Implement interface by connecting directly to the Axi
 * machine. Used on serverless configuration (IS_WEB is set), where the control is handled
 * directly on the browser.
 */
export class WebSerialDriver extends BaseDriver {
  private _unpaused: Promise<void> | null = null;
  private _signalUnpause: (() => void) | null = null;
  private _cancelRequested = false;
  private _disconnectHandler: ((event: Event) => void) | null = null;

  public static async connect(port?: SerialPort, hardware: Hardware = 'v3') {
    if (!port)
      // biome-ignore lint/style/noParameterAssign: trivial
      port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x04D8, usbProductId: 0xFD92 }] });
    // baudRate ref: https://github.com/evil-mad/plotink/blob/a45739b7d41b74d35c1e933c18949ed44c72de0e/plotink/ebb_serial.py#L281
    // (doesn't specify baud rate)
    // and https://pyserial.readthedocs.io/en/latest/pyserial_api.html#serial.Serial.__init__
    // (pyserial defaults to 9600)
    await port.open({ baudRate: 9600 });
    const { usbVendorId, usbProductId } = port.getInfo();
    const ebb = new EBB(port, hardware);

    const vendorId = usbVendorId?.toString(16).padStart(4, '0');
    const productId = usbProductId?.toString(16).padStart(4, '0');
    const name = `${vendorId}:${productId}`;

    const driver = new WebSerialDriver(ebb, name);
    driver._disconnectHandler = (event: Event) => {
      if (event.target === port) {
        driver.handleDisconnection();
      }
    };
    navigator.serial.addEventListener('disconnect', driver._disconnectHandler);
    driver.connected = true;

    return driver;
  }

  private _name: string;
  public name(): string {
    return this._name;
  }

  private ebb: EBB;
  private constructor(ebb: EBB, name: string) {
    super();
    this.ebb = ebb;
    this._name = name;
  }

  private handleDisconnection(): void {
    console.log('WebSerial device disconnected');
    this.connected = false;
  }

  public async close(): Promise<void> {
    this.handleDisconnection();
    navigator.serial.removeEventListener('disconnect', this._disconnectHandler);
    return this.ebb.close();
  }

  public async plot(plan: Plan): Promise<void> {
    const microsteppingMode = 1; // 16x microstepping, matches defaults from Axidraw
    this._unpaused = null;
    this._cancelRequested = false;
    await this.ebb.enableMotors(microsteppingMode);

    let motionIdx = 0;
    let penIsUp = true;
    for (const motion of plan.motions) {
      this.onprogress(motionIdx);
      await this.ebb.executeMotion(motion);
      if (motion instanceof PenMotion) {
        penIsUp = motion.initialPos < motion.finalPos;
      }
      if (this._unpaused && penIsUp) {
        await this._unpaused;
        this.onpause(false);
      }
      if (this._cancelRequested) { break; }
      motionIdx += 1;
    }

    if (this._cancelRequested) {
      const device = Device(this.ebb.hardware);
      if (!penIsUp) {
        // Move to the pen up position, or 50% if no position was found
        const penMotion = plan.motions.find((motion): motion is PenMotion => motion instanceof PenMotion);
        const penUpPosition = penMotion ? Math.max(penMotion.initialPos, penMotion.finalPos) : device.penPctToPos(50);
        await this.ebb.setPenHeight(penUpPosition, 1000);
        await this.ebb.command('HM,4000'); // HM returns carriage home without 3rd and 4th arguments
      }
      this.oncancelled();
    } else {
      this.onfinished();
    }

    await this.ebb.waitUntilMotorsIdle();
    await this.ebb.disableMotors();
  }

  public cancel(): void {
    this._cancelRequested = true;
  }

  public pause(): void {
    this._unpaused = new Promise(resolve => {
      this._signalUnpause = resolve;
    });
    this.onpause(true);
  }

  public resume(): void {
    const signal = this._signalUnpause;
    this._unpaused = null;
    this._signalUnpause = null;
    signal?.();
  }

  public async setPenHeight(height: number, rate: number): Promise<void> {
    if (await this.ebb.supportsSR()) {
      await this.ebb.setServoPowerTimeout(10000, true);
    }
    await this.ebb.setPenHeight(height, rate);
  }

  public limp(): void {
    this.ebb.disableMotors();
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
  svgioEnabled: ((enabled: boolean) => void);

  public name() {
    return 'Saxi Server';
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
    });
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
      body: new Blob([JSON.stringify(plan.serialize())], { type: 'application/json' })
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

  public limp() { this.send({ c: "limp" }); }
  public ping() { this.send({ c: "ping" }); }
}
