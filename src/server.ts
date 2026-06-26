/**
 * Backend web server for controlling the EBB.
 * Serve both the front end UI as static files - made with React, and backend
 * API for controlling the EBB.
 * Keep open web sockets to the front end for real-time updates.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoDetect } from "@serialport/bindings-cpp";
import type { PortInfo } from "@serialport/bindings-interface";
import cors from "cors";
import type { Request, Response } from "express";
import express from "express";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { EBB, type Hardware } from "./ebb.js";
import { createInProcessTransport, type HostTransport } from "./node-ebb-host.js";
import { type MotionData, PenMotion, Plan } from "./planning.js";
import type { HostEvent } from "./serial-worker-rpc.js";
import { SerialPortSerialPort } from "./serialport-serialport.js";
import * as _self from "./server.js"; // use self-import for test mocking
import { formatDuration } from "./util.js";

type Com = string;

/**
 * Start the express server.
 * @param port
 * @param hardware
 * @param com
 * @param enableCors
 * @param maxPayloadSize
 * @returns
 */
export async function startServer(
  port: number,
  hardware: Hardware = "v3",
  com: Com = "",
  enableCors = false,
  maxPayloadSize = "200mb",
  svgIoApiKey = "",
) {
  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use("/", express.static(path.join(__dirname, "..", "ui")));
  app.use(express.json({ limit: maxPayloadSize }));
  if (enableCors) {
    app.use(cors());
  }
  // Web and Socket server
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  // The EBB + plot loop now runs off the server's main thread, in the shared
  // host (see node-ebb-host.ts / serial-worker-node.ts). The server only tracks
  // device + plot state, forwards commands to the host, and relays its events to
  // the ws clients. `transport` is null when no device is connected (sim mode).
  let transport: HostTransport | null = null;
  let deviceInfo: { path: string | null; hardware: Hardware } = { path: null, hardware };
  let connected = false;
  let clients: WebSocket[] = [];
  let motionIdx: number | null = null;
  let currentPlan: MotionData[] | null = null;
  let plotting = false;
  let paused = false;
  let plotBegin = 0;
  let wakeLock: { release(): void } | null = null;
  let resolveDisconnect: (() => void) | null = null;

  // Simulation-mode plot state (no device): kept entirely in-process. The real
  // path drives the host instead and never touches these.
  let simUnpaused: Promise<void> | null = null;
  let simSignalUnpause: (() => void) | null = null;
  let simController: AbortController | null = null;

  const devInfo = () => ({ path: deviceInfo.path, hardware: deviceInfo.hardware });

  wss.on("connection", (ws) => {
    clients.push(ws);
    ws.on("message", (message) => {
      const msg = JSON.parse(message.toString());
      switch (msg.c) {
        case "ping":
          ws.send(JSON.stringify({ c: "pong" }));
          break;
        case "limp":
          transport?.handle({ kind: "limp" });
          break;
        case "setPenHeight":
          transport?.handle({ kind: "setPenHeight", height: msg.p.height, rate: msg.p.rate });
          break;
        case "changeHardware":
          deviceInfo = { ...deviceInfo, hardware: msg.p.hardware };
          transport?.handle({ kind: "changeHardware", hardware: msg.p.hardware });
          broadcast({ c: "dev", p: devInfo() });
          break;
      }
    });

    // send starting params to clients
    ws.send(JSON.stringify({ c: "dev", p: devInfo() }));

    ws.send(JSON.stringify({ c: "svgio-enabled", p: svgIoApiKey !== "" }));

    ws.send(JSON.stringify({ c: "pause", p: { paused } }));
    if (motionIdx != null) {
      ws.send(JSON.stringify({ c: "progress", p: { motionIdx } }));
    }
    if (currentPlan != null) {
      ws.send(JSON.stringify({ c: "plan", p: { plan: currentPlan } }));
    }

    ws.on("close", () => {
      clients = clients.filter((w) => w !== ws);
    });
  });

  /** Relay host lifecycle events to the ws clients and track server-side state. */
  function handleHostEvent(event: HostEvent): void {
    switch (event.kind) {
      case "ready":
        connected = true;
        broadcast({ c: "dev", p: devInfo() });
        break;
      case "progress":
        motionIdx = event.motionIdx;
        broadcast({ c: "progress", p: { motionIdx } });
        break;
      case "paused":
        paused = event.paused;
        broadcast({ c: "pause", p: { paused } });
        break;
      case "finished":
        broadcast({ c: "finished" });
        endPlot();
        break;
      case "cancelled":
        broadcast({ c: "cancelled" });
        endPlot();
        break;
      case "error":
        console.error(`[serial-host] ${event.message}`);
        // Before "ready" this means the port never opened — drop the connection
        // so the connect loop retries. During a plot, end it so the server unsticks.
        if (!connected) resolveDisconnect?.();
        else if (plotting) endPlot();
        break;
      case "disconnected":
        connected = false;
        // A disconnect mid-plot won't produce finished/cancelled, so end it here
        // (frees the wake lock and clears `plotting`) before reconnecting.
        if (plotting) {
          broadcast({ c: "cancelled" });
          endPlot();
        }
        resolveDisconnect?.();
        break;
    }
  }

  /** Clear plot state once a plot ends (finished / cancelled / failed). */
  function endPlot(): void {
    if (plotting) {
      console.log(`Plot took ${formatDuration((Date.now() - plotBegin) / 1000)}`);
    }
    plotting = false;
    paused = false;
    motionIdx = null;
    currentPlan = null;
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
  }

  async function acquireWakeLock(): Promise<void> {
    // The wake-lock module is macOS-only.
    if (process.platform === "darwin") {
      try {
        const { WakeLock } = await import("wake-lock");
        wakeLock = new WakeLock("saxi plotting");
      } catch (_error) {
        console.warn("Couldn't acquire wake lock. Ensure your machine does not sleep during plotting");
      }
    } else {
      console.log("Wake lock not available on this platform. Ensure your machine does not sleep during plotting");
    }
  }

  /**
   * /plot POST endpoint. Receive a plan on the POST body, and execute it.
   */
  app.post("/plot", async (req: Request, res: Response) => {
    if (plotting) {
      console.log("Received plot request, but a plot is already in progress!");
      res.status(400).send("Plot in progress");
      return;
    }
    let plan: Plan;
    try {
      plan = Plan.deserialize(req.body);
    } catch (_e) {
      res.status(500).send("Malformed plan");
      return;
    }

    plotting = true;
    paused = false;
    motionIdx = 0;
    currentPlan = req.body;
    plotBegin = Date.now();
    console.log(`Received plan of estimated duration ${formatDuration(plan.duration())}`);
    console.log(transport != null ? "Beginning plot..." : "Simulating plot...");
    res.status(200).end();

    await acquireWakeLock();

    if (transport) {
      // The worker host runs the whole plot loop and reports back via events
      // (progress / paused / finished / cancelled), which endPlot()s the server.
      transport.handle({ kind: "plot", plan: req.body });
    } else {
      // No device: simulate the plot in-process so the UI preview still animates.
      simulatePlot(plan).catch((err) => {
        console.error("Simulated plot failed:", err);
        broadcast({ c: "cancelled" });
        endPlot();
      });
    }
  });

  app.get("/plot/status", (_req, res) => {
    res.json({ plotting });
  });

  app.post("/cancel", (_req: Request, res: Response) => {
    if (transport) {
      transport.handle({ kind: "cancel" });
    } else {
      // Sim mode: abort the in-process loop and release any pause gate.
      simController?.abort();
      simController = null;
      if (simSignalUnpause) {
        simSignalUnpause();
        simSignalUnpause = simUnpaused = null;
      }
    }
    res.status(200).end();
  });

  app.post("/pause", (_req: Request, res: Response) => {
    if (transport) {
      // The host emits a "paused" event, which broadcasts to the clients.
      transport.handle({ kind: "pause" });
    } else if (!simUnpaused) {
      paused = true;
      simUnpaused = new Promise((resolve) => {
        simSignalUnpause = resolve;
      });
      broadcast({ c: "pause", p: { paused: true } });
    }
    res.status(200).end();
  });

  app.post("/resume", (_req: Request, res: Response) => {
    if (transport) {
      transport.handle({ kind: "resume" });
    } else if (simSignalUnpause) {
      paused = false;
      simSignalUnpause();
      simSignalUnpause = simUnpaused = null;
      broadcast({ c: "pause", p: { paused: false } });
    }
    res.status(200).end();
  });

  app.post("/generate", async (req: Request, res: Response) => {
    if (plotting) {
      console.log("Received generate request, but a plot is already in progress!");
      res.status(400).end("Plot in progress");
      return;
    }
    const { prompt, vecType } = req.body;
    try {
      // call the api and return the svg
      const apiResp = await fetch("https://api.svg.io/v1/generate-image", {
        method: "post",
        headers: {
          Authorization: `Bearer ${svgIoApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt, style: vecType, negativePrompt: "" }),
      });
      // forward the api response
      const data = await apiResp.json();
      res.status(apiResp.status).send(data);
    } catch (err) {
      console.error(err);
      res.status(500).end();
    }
  });

  function broadcast(msg: Record<string, unknown>) {
    for (const client of clients) {
      try {
        client.send(JSON.stringify(msg));
      } catch (e) {
        console.warn(e);
      }
    }
  }

  /**
   * In-process plot simulation, used only when no device is connected, so the
   * UI preview still animates. The real path runs the whole loop in the host.
   */
  async function simulatePlot(plan: Plan): Promise<void> {
    const controller = new AbortController();
    simController = controller;
    const { signal } = controller;
    const abort = onceAbort(signal);

    let penIsUp = true;
    try {
      for (const [i, motion] of plan.motions.entries()) {
        motionIdx = i;
        broadcast({ c: "progress", p: { motionIdx } });
        console.log(`Motion ${i + 1}/${plan.motions.length}`);
        await Promise.race([sleep(motion.duration() * 1000), abort]);

        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos < motion.finalPos;
        }
        // Hold at motion boundaries while paused (only with the pen up, so we
        // never stop mid-stroke), matching the host's pause behavior.
        if (simUnpaused && penIsUp) {
          await Promise.race([simUnpaused, abort]);
        }
      }
      broadcast({ c: "finished" });
    } catch (err) {
      if (signal.aborted) {
        console.log("Plot cancelled");
        broadcast({ c: "cancelled" });
      } else {
        throw err;
      }
    } finally {
      simController = null;
      simUnpaused = simSignalUnpause = null;
      endPlot();
    }
  }

  function onceAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  }

  /**
   * Discover the EBB, hand its serial path to the off-thread host, and keep the
   * connection alive — reconnecting when the device drops (mirroring the old
   * ebbs() generator). The host owns the port: a worker_thread in production, or
   * an in-process host under vitest so the mocked serialport applies.
   */
  async function connectLoop(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Did this attempt reach a live connection? If not (open failed, which the
      // worker reports as an event rather than a throw), back off before retrying
      // so a bad/busy port doesn't hot-loop.
      let everConnected = false;
      const disconnected = new Promise<void>((resolve) => {
        resolveDisconnect = resolve;
      });
      try {
        const dev: Com = com || (await _self.waitForEbb()); // self-import for test mocking
        console.log(`Found EBB at ${dev}`);
        deviceInfo = { path: dev, hardware: deviceInfo.hardware };
        // Runs the shared host in-process: serialport's native binding faults
        // ("HandleScope without locking") when driven from a worker_thread, so
        // unlike the browser (WebSerial worker) the Node loop stays on the main
        // thread. The deep FIFO (#309) is what keeps it stutter-free here.
        transport = await createInProcessTransport(dev, deviceInfo.hardware, handleHostEvent);
        await disconnected;
        everConnected = connected;
        console.error(everConnected ? "Lost connection to EBB, reconnecting..." : "Couldn't open EBB, retrying...");
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(`Error connecting to EBB: ${err.message}`);
      } finally {
        resolveDisconnect = null;
        connected = false;
        const t = transport;
        transport = null;
        await t?.close().catch(() => {});
        deviceInfo = { path: null, hardware: deviceInfo.hardware };
        broadcast({ c: "dev", p: devInfo() });
      }
      if (!everConnected) await sleep(5000);
    }
  }

  return new Promise<http.Server>((resolve) => {
    server.listen(port, () => {
      connectLoop();
      const { family, address, port } = server.address() as AddressInfo;
      const addr = `${family === "IPv6" ? `[${address}]` : address}:${port}`;
      console.log(`Server listening on http://${addr}`);
      resolve(server);
    });
  });
}

async function tryOpen(com: Com) {
  const port = new SerialPortSerialPort(com);
  await port.open({ baudRate: 9600 });
  return port;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEBB(p: PortInfo): boolean {
  return (
    p.manufacturer === "SchmalzHaus" ||
    p.manufacturer === "SchmalzHaus LLC" ||
    (p.vendorId === "04D8" && p.productId === "FD92")
  );
}

async function listEBBs() {
  const Binding = autoDetect();
  const ports = await Binding.list();
  return ports.filter(isEBB).map((p: { path: string }) => p.path);
}

export async function waitForEbb(): Promise<Com> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ebbs = await listEBBs();
    if (ebbs.length) {
      return ebbs[0];
    }
    await sleep(5000);
  }
}

export async function connectEBB(hardware: Hardware, device?: string): Promise<EBB | null> {
  const dev = device ?? (await listEBBs())[0];
  if (!dev) return null;

  const port = await tryOpen(dev);
  return new EBB(port, hardware);
}
