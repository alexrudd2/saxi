import cors from "cors";
import "web-streams-polyfill/es2018"
import express from "express";
import http from "http";
import path from "path";
import { PortInfo } from "@serialport/bindings-interface"
import { WakeLock } from "wake-lock";
import WebSocket from "ws";
import { SerialPortSerialPort } from "./serialport-serialport";
import { Device, PenMotion, Motion, Plan } from "./planning";
import { formatDuration } from "./util";
import { autoDetect } from '@serialport/bindings-cpp';
import * as _self from './server'  // use self-import for test mocking

import { EBB, Hardware } from './ebb'

type Com = string

const getDeviceInfo = (ebb: EBB | null, com: Com) => {
  return { com: ebb ? com : null, hardware: ebb?.hardware }
}

export async function startServer (port: number, hardware: Hardware = 'v3', com: Com = null, enableCors = false, maxPayloadSize = '200mb') {
  const app = express()
  app.use('/', express.static(path.join(__dirname, '..', 'ui')))
  app.use(express.json({ limit: maxPayloadSize }))
  if (enableCors) {
    app.use(cors());
  }

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  let ebb: EBB | null;
  let clients: WebSocket[] = [];
  let cancelRequested = false;
  let unpaused: Promise<void> | null = null;
  let signalUnpause: () => void | null = null;
  let motionIdx: number | null = null;
  let currentPlan: Plan | null = null;
  let plotting = false

  wss.on("connection", (ws) => {
    clients.push(ws);
    ws.on("message", (message) => {
      const msg = JSON.parse(message.toString());
      switch (msg.c) {
        case "ping":
          ws.send(JSON.stringify({c: "pong"}));
          break;
        case "limp":
          if (ebb) { ebb.disableMotors(); }
          break;
        case "setPenHeight":
          if (ebb) {
            (async () => {
              if (await ebb.supportsSR()) {
                await ebb.setServoPowerTimeout(10000, true)
              }
              await ebb.setPenHeight(msg.p.height, msg.p.rate);
            })();
          }
          break;
      }
    });

    ws.send(JSON.stringify({ c: 'dev', p: getDeviceInfo(ebb, com) }))

    ws.send(JSON.stringify({ c: 'pause', p: { paused: !!unpaused } }))
    if (motionIdx != null) {
      ws.send(JSON.stringify({c: "progress", p: {motionIdx}}));
    }
    if (currentPlan != null) {
      ws.send(JSON.stringify({c: "plan", p: {plan: currentPlan}}));
    }

    ws.on("close", () => {
      clients = clients.filter((w) => w !== ws);
    });
  });

  app.post("/plot", async (req, res) => {
    if (plotting) {
      console.log("Received plot request, but a plot is already in progress!")
      return res.status(400).end('Plot in progress')
    }
    plotting = true
    try {
      const plan = Plan.deserialize(req.body);
      currentPlan = req.body;
      console.log(`Received plan of estimated duration ${formatDuration(plan.duration())}`);
      console.log(ebb != null ? "Beginning plot..." : "Simulating plot...");
      res.status(200).end();

      const begin = Date.now();
      let wakeLock: any;
      if (process.platform === 'darwin') {
        try {
          wakeLock = new WakeLock("saxi plotting");
        } catch (e) {
          console.warn("Couldn't acquire wake lock. Ensure your machine does not sleep during plotting");
        }
      }

      try {
        await doPlot(ebb != null ? realPlotter : simPlotter, plan);
        const end = Date.now();
        console.log(`Plot took ${formatDuration((end - begin) / 1000)}`);
      } finally {
        if (wakeLock) {
          wakeLock.release();
        }
      }
    } finally {
      plotting = false
    }
  });

  app.post("/cancel", (req, res) => {
    cancelRequested = true;
    if (unpaused) {
      signalUnpause();
    }
    unpaused = signalUnpause = null;
    res.status(200).end();
  });

  app.post("/pause", (req, res) => {
    if (!unpaused) {
      unpaused = new Promise(resolve => {
        signalUnpause = resolve;
      });
      broadcast({c: "pause", p: {paused: true}});
    }
    res.status(200).end();
  });

  app.post("/resume", (req, res) => {
    if (signalUnpause) {
      signalUnpause();
      signalUnpause = unpaused = null;
    }
    res.status(200).end();
  })

  function broadcast(msg: any) {
    clients.forEach((ws) => {
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        console.warn(e);
      }
    });
  }

  interface Plotter {
    prePlot: (initialPenHeight: number) => Promise<void>;
    executeMotion: (m: Motion, progress: [number, number]) => Promise<void>;
    postCancel: () => Promise<void>;
    postPlot: () => Promise<void>;
  }

  const realPlotter: Plotter = {
    async prePlot(initialPenHeight: number): Promise<void> {
      await ebb.enableMotors(2);
      await ebb.setPenHeight(initialPenHeight, 1000, 1000);
    },
    async executeMotion(motion: Motion, _progress: [number, number]): Promise<void> {
      await ebb.executeMotion(motion);
    },
    async postCancel(): Promise<void> {
      const device = Device(ebb.hardware)
      await ebb.setPenHeight(device.penPctToPos(0), 1000);
    },
    async postPlot(): Promise<void> {
      await ebb.waitUntilMotorsIdle();
      await ebb.disableMotors();
    }
  }

  const simPlotter: Plotter = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async prePlot(_initialPenHeight: number): Promise<void> {
    },
    async executeMotion(motion: Motion, progress: [number, number]): Promise<void> {
      console.log(`Motion ${progress[0] + 1}/${progress[1]}`);
      await new Promise((resolve) => setTimeout(resolve, motion.duration() * 1000));
    },
    async postCancel(): Promise<void> {
      console.log("Plot cancelled");
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async postPlot(): Promise<void> {
    },
  };

  async function doPlot(plotter: Plotter, plan: Plan): Promise<void> {
    cancelRequested = false;
    unpaused = null;
    signalUnpause = null;
    motionIdx = 0;

    const firstPenMotion = (plan.motions.find((x) => x instanceof PenMotion) as PenMotion);
    await plotter.prePlot(firstPenMotion.initialPos);

    let penIsUp = true;

    for (const motion of plan.motions) {
      broadcast({c: "progress", p: {motionIdx}});
      await plotter.executeMotion(motion, [motionIdx, plan.motions.length]);
      if (motion instanceof PenMotion) {
        penIsUp = motion.initialPos < motion.finalPos;
      }
      if (unpaused && penIsUp) {
        await unpaused;
        broadcast({c: "pause", p: {paused: false}});
      }
      if (cancelRequested) { break; }
      motionIdx += 1;
    }
    motionIdx = null;
    currentPlan = null;
    if (cancelRequested) {
      await plotter.postCancel();
      broadcast({c: "cancelled"});
      cancelRequested = false;
    } else {
      broadcast({c: "finished"});
    }
    await plotter.postPlot();
  }

  return new Promise<http.Server>((resolve) => {
    server.listen(port, () => {
      async function connect () {
        const devices = ebbs(com, hardware)
        for await (const device of devices) {
          ebb = device
          broadcast({ c: 'dev', p: getDeviceInfo(ebb, com) })
        }
      }
      connect();
      const {family, address, port} = server.address() as any;
      const addr = `${family === "IPv6" ? `[${address}]` : address}:${port}`;
      console.log(`Server listening on http://${addr}`);
      resolve(server);
    });
  });
}

async function tryOpen (com: Com) {
  const port = new SerialPortSerialPort(com)
  await port.open({ baudRate: 9600 })
  return port
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEBB(p: PortInfo): boolean {
  return p.manufacturer === "SchmalzHaus" || p.manufacturer === "SchmalzHaus LLC" || (p.vendorId == "04D8" && p.productId == "FD92");
}

async function listEBBs() {
  const Binding = autoDetect()
  const ports = await Binding.list();
  return ports.filter(isEBB).map((p: { path: any; }) => p.path);
}

export async function waitForEbb (): Promise<Com> {
// eslint-disable-next-line no-constant-condition
  while (true) {
    const ebbs = await listEBBs();
    if (ebbs.length) {
      return ebbs[0];
    }
    await sleep(5000);
  }
}

async function * ebbs (path?: string, hardware: Hardware = 'v3') {
  while (true) {
    try {
      const com: Com = path || (await _self.waitForEbb()) // use self-import for test mocking
      console.log(`Found EBB at ${com}`)
      const port = await tryOpen(com)
      const closed = new Promise((resolve) => {
        port.addEventListener('disconnect', resolve, { once: true })
      })
      yield new EBB(port, hardware)
      await closed
      yield null
      console.error('Lost connection to EBB, reconnecting...')
    } catch (e) {
      console.error(`Error connecting to EBB: ${e.message}`);
      console.error(`Retrying in 5 seconds...`);
      await sleep(5000);
    }
  }
}

export async function connectEBB (hardware: Hardware = 'v3', device: string | undefined): Promise<EBB | null> {
  if (!device) {
    const ebbs = await listEBBs()
    if (ebbs.length === 0) return null
    device = ebbs[0]
  }

  const port = await tryOpen(device)
  return new EBB(port, hardware)
}
