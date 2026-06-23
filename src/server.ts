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
import cors from "cors";
import type { Request, Response } from "express";
import express from "express";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { createEbbProxy } from "./ebb-proxy.js";
import type { Hardware } from "./ebb.js";
import { type Motion, PenMotion, Plan } from "./planning.js";
import { type Com, connectEBB, waitForEbb } from "./serial-device.js";
import { formatDuration } from "./util.js";

// Re-exported for the CLI (saxi plot/pen) and tests, which still talk to the
// EBB directly rather than through the worker.
export { connectEBB, waitForEbb };

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

  // The EBB lives on its own worker thread; ebbProxy mirrors its API on the
  // main thread. Starting it at boot (not per plot) keeps worker startup off
  // the plotting path. See PERF_PLAN.md workstream B.
  const ebbProxy = await createEbbProxy({ com: com ?? undefined, hardware });

  let clients: WebSocket[] = [];
  let unpaused: Promise<void> | null = null;
  let signalUnpause: (() => void) | null = null;
  let motionIdx: number | null = null;
  // The in-progress plan, kept as serialized JSON. Parsed, it is hundreds of
  // thousands of small objects that every major GC must traverse for the whole
  // duration of the plot; its only use is being re-sent to websocket clients.
  let currentPlanJson: string | null = null;
  let plotting = false;
  let controller: AbortController | null = null;

  const getDeviceInfo = () => ({
    path: ebbProxy.devicePath,
    hardware: ebbProxy.connected ? ebbProxy.hardware : undefined,
  });

  // The worker reports connect/disconnect (and hardware changes) as `dev` events.
  ebbProxy.on("dev", () => broadcast({ c: "dev", p: getDeviceInfo() }));

  wss.on("connection", (ws) => {
    clients.push(ws);
    ws.on("message", (message) => {
      const msg = JSON.parse(message.toString());
      switch (msg.c) {
        case "ping":
          ws.send(JSON.stringify({ c: "pong" }));
          break;
        case "limp":
          if (ebbProxy.connected) {
            ebbProxy.disableMotors();
          }
          break;
        case "setPenHeight":
          if (ebbProxy.connected) {
            (async () => {
              if (await ebbProxy.supportsSR()) {
                await ebbProxy.setServoPowerTimeout(10000, true);
              }
              await ebbProxy.setPenHeight(msg.p.height, msg.p.rate);
            })();
          }
          break;
        case "changeHardware":
          ebbProxy.changeHardware(msg.p.hardware);
          broadcast({ c: "dev", p: getDeviceInfo() });
          break;
      }
    });

    // send starting params to clients
    ws.send(JSON.stringify({ c: "dev", p: getDeviceInfo() }));

    ws.send(JSON.stringify({ c: "svgio-enabled", p: svgIoApiKey !== "" }));

    ws.send(JSON.stringify({ c: "pause", p: { paused: !!unpaused } }));
    if (motionIdx != null) {
      ws.send(JSON.stringify({ c: "progress", p: { motionIdx } }));
    }
    if (currentPlanJson != null) {
      ws.send(`{"c":"plan","p":{"plan":${currentPlanJson}}}`);
    }

    ws.on("close", () => {
      clients = clients.filter((w) => w !== ws);
    });
  });

  /**
   * /plot POST endpoint. Receive a plan on the POST body, and execute it.
   */
  app.post("/plot", async (req: Request, res: Response) => {
    if (plotting) {
      console.log("Received plot request, but a plot is already in progress!");
      res.status(400).send("Plot in progress");
      return;
    }
    plotting = true;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const plan = Plan.deserialize(req.body);
      currentPlanJson = JSON.stringify(req.body); // once, before motion starts
      console.log(`Received plan of estimated duration ${formatDuration(plan.duration())}`);
      console.log(ebbProxy.connected ? "Beginning plot..." : "Simulating plot...");
      res.status(200).end();

      const begin = Date.now();
      let wakeLock: { release(): void } | null = null;

      // The wake-lock module is macOS-only.
      if (process.platform === "darwin") {
        try {
          // Dynamically import wake-lock only on macOS
          const { WakeLock } = await import("wake-lock");
          wakeLock = new WakeLock("saxi plotting");
        } catch (_error) {
          console.warn("Couldn't acquire wake lock. Ensure your machine does not sleep during plotting");
        }
      } else {
        console.log("Wake lock not available on this platform. Ensure your machine does not sleep during plotting");
      }
      try {
        await doPlot(ebbProxy.connected ? realPlotter : simPlotter, plan, signal);
        const end = Date.now();
        console.log(`Plot took ${formatDuration((end - begin) / 1000)}`);
      } finally {
        if (wakeLock) {
          wakeLock.release();
        }
      }
    } finally {
      plotting = false;
      controller = null;
    }
  });

  app.get("/plot/status", (_req, res) => {
    res.json({ plotting });
  });

  app.post("/cancel", (_req: Request, res: Response) => {
    if (controller) {
      controller.abort();
      controller = null;
    }
    ebbProxy.cancel();
    if (unpaused) {
      signalUnpause?.();
      broadcast({ c: "pause", p: { paused: false } });
    }
    unpaused = signalUnpause = null;
    res.status(200).end();
  });

  app.post("/pause", (_req: Request, res: Response) => {
    if (!unpaused) {
      unpaused = new Promise((resolve) => {
        signalUnpause = resolve;
      });
      broadcast({ c: "pause", p: { paused: true } });
    }
    res.status(200).end();
  });

  app.post("/resume", (_req: Request, res: Response) => {
    if (signalUnpause) {
      signalUnpause();
      signalUnpause = unpaused = null;
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

  interface Plotter {
    prePlot: (initialPenHeight: number) => Promise<void>;
    executeMotion: (m: Motion, progress: [number, number]) => Promise<void>;
    postCancel: (initialPenHeight: number) => Promise<void>;
    postPlot: () => Promise<void>;
  }

  const realPlotter: Plotter = {
    async prePlot(initialPenHeight: number): Promise<void> {
      await ebbProxy.resetTelemetry();
      await ebbProxy.setFifoLedIndicator(true);
      await ebbProxy.configureFifoDepth();
      await ebbProxy.enableMotors(1); // 16x microstepping, matches defaults from Axidraw
      await ebbProxy.setPenHeight(initialPenHeight, 1000, 1000);
    },
    async executeMotion(motion: Motion, _progress: [number, number]): Promise<void> {
      await ebbProxy.executeMotion(motion);
    },
    async postCancel(initialPenHeight: number): Promise<void> {
      // The board may still be executing motion queued in its FIFO; issuing
      // HM while moving makes the steppers grind against whatever they're doing.
      await ebbProxy.waitUntilMotorsIdle();
      await ebbProxy.setPenHeight(initialPenHeight, 1000);
      await ebbProxy.command("HM,4000"); // HM returns carriage home without 3rd and 4th arguments
    },
    async postPlot(): Promise<void> {
      await ebbProxy.waitUntilMotorsIdle();
      await ebbProxy.setFifoLedIndicator(false);
      await ebbProxy.disableMotors();
      await ebbProxy.logTelemetrySummary();
    },
  };

  const simPlotter: Plotter = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async prePlot(_initialPenHeight: number): Promise<void> {},
    async executeMotion(motion: Motion, progress: [number, number]): Promise<void> {
      console.log(`Motion ${progress[0] + 1}/${progress[1]}`);
      await new Promise((resolve) => setTimeout(resolve, motion.duration() * 1000));
    },
    async postCancel(_initialPenHeight: number): Promise<void> {
      console.log("Plot cancelled");
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async postPlot(): Promise<void> {},
  };

  async function doPlot(plotter: Plotter, plan: Plan, signal: AbortSignal): Promise<void> {
    const abortPromise = onceAbort(signal); // reuse abort promise
    unpaused = null;
    signalUnpause = null;
    motionIdx = 0;

    const firstPenMotion = plan.motions.find((x) => x instanceof PenMotion) as PenMotion;
    await plotter.prePlot(firstPenMotion.initialPos);

    let penIsUp = true;
    try {
      for (const motion of plan.motions) {
        broadcast({ c: "progress", p: { motionIdx } });

        await Promise.race([plotter.executeMotion(motion, [motionIdx, plan.motions.length]), abortPromise]);

        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos < motion.finalPos;
        }

        if (unpaused && penIsUp) {
          await Promise.race([unpaused, abortPromise]);
          broadcast({ c: "pause", p: { paused: false } });
        }

        motionIdx += 1;
      }

      broadcast({ c: "finished" });
    } catch (err) {
      if (signal.aborted) {
        await plotter.postCancel(firstPenMotion.initialPos);
        broadcast({ c: "cancelled" });
        return;
      }
      throw err; // propagate real errors
    } finally {
      motionIdx = null;
      currentPlanJson = null;
      await plotter.postPlot();
    }
  }

  function onceAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  }

  return new Promise<http.Server>((resolve) => {
    server.listen(port, () => {
      // The worker started connecting when ebbProxy was created above; its dev
      // events drive the broadcast. Nothing more to start here.
      const { family, address, port } = server.address() as AddressInfo;
      const addr = `${family === "IPv6" ? `[${address}]` : address}:${port}`;
      console.log(`Server listening on http://${addr}`);
      resolve(server);
    });
  });
}
