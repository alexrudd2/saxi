import "web-streams-polyfill/polyfill";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from 'node:path';
import { autoDetect } from '@serialport/bindings-cpp';
import type { PortInfo } from "@serialport/bindings-interface";
import serveStatic from 'serve-static';
import { WakeLock } from "wake-lock";
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { EBB, type Hardware } from './ebb.js';
import { type Motion, PenMotion, Plan } from "./planning.js";
import { SerialPortSerialPort } from "./serialport-serialport.js";
import * as _self from './server.js';  // use self-import for test mocking
import { formatDuration } from "./util.js";

type Com = string

const getDeviceInfo = (ebb: EBB | null, com: Com) => {
  return { com: ebb ? com : null, hardware: ebb?.hardware };
};

export async function startServer(port: number, hardware: Hardware = 'v3', com: Com = null, enableCors = false, _maxPayloadSize = '200mb', svgIoApiKey = '') {

  const server = http.createServer(async(req, res) => {
    const staticServe = serveStatic(path.join(path.resolve(), 'dist', 'ui'));
    if (enableCors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader("Access-Control-Allow-Headers", "*");
    }
    if (req.method === 'GET') {
      staticServe(req, res, () => {});
    }
    if (req.method === 'POST' && req.url === '/pause') {
      if (!unpaused) {
        unpaused = new Promise(resolve => {
          signalUnpause = resolve;
        });
      }
      res.writeHead(200).end();
      return;
    }

    if (req.method === 'POST' && req.url === '/plot') {
      if (plotting) {
        console.log("Received plot request, but a plot is already in progress!");
        res.writeHead(400).end('Plot in progress');
        return;
      }
      plotting = true;
      let body = '';
      // biome-ignore lint/suspicious/noAssignInExpressions: concise
      req.on('data', chunk => (body += chunk));
      req.on('end', async() => {
        try {
          const plan = Plan.deserialize(JSON.parse(body));
          currentPlan = JSON.parse(body);
          console.log(`Received plan of estimated duration ${formatDuration(plan.duration())}`);
          console.log(ebb != null ? "Beginning plot..." : "Simulating plot...");
          res.writeHead(200);
          res.end();
    
          const begin = Date.now();
          // biome-ignore lint/suspicious/noExplicitAny: need a new strategy for wakeLock
          let wakeLock: any;
          // The wake-lock module is macOS-only.
          if (process.platform === 'darwin') {
            try {
              wakeLock = new WakeLock("saxi plotting");
            } catch {
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
          plotting = false;
        }
      });
    }
    
    if (req.method === 'POST' && req.url === '/cancel') {
      cancelRequested = true;
      if (unpaused) {
        signalUnpause();
      }
      unpaused = signalUnpause = null;
      res.writeHead(200).end();
      return;
    }

    if (req.method === 'POST' && req.url === '/pause') {
      if (!unpaused) {
        unpaused = new Promise(resolve => {
          signalUnpause = resolve;
        });
        broadcast({ c: "pause", p: { paused: true } });
      }
      res.writeHead(200).end();
      return;
    }

    if (req.method === 'POST' && req.url === '/resume') {
      if (signalUnpause) {
        signalUnpause();
        signalUnpause = unpaused = null;
      }
      res.writeHead(200).end();
      return;
    }

    if (req.method === 'POST' && req.url === '/generate') {
      if (plotting) {
        console.log("Received generate request, but a plot is already in progress!");
        res.writeHead(400);
        res.end('Plot in progress');
        return;
      }
      let body = '';
      // biome-ignore lint/suspicious/noAssignInExpressions: concise
      req.on('data', chunk => (body += chunk));
      req.on('end', async() => {
        const { prompt, vecType } = JSON.parse(body);
        try {
          // call the api and return the svg
          const apiResp = await fetch('https://api.svg.io/v1/generate-image', {
            method: 'post',
            headers: {
              Authorization: `Bearer ${svgIoApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ prompt, style: vecType, negativePrompt: '' })
          });
          // forward the api response
          const data = await apiResp.json();
          res.writeHead(apiResp.status);
          res.write(data);
          res.end();
        } catch (err) {
          console.error(err);
          res.writeHead(500);
          res.end();
        }
      });
    }


  });
  const wss = new WebSocketServer({ server });

  let ebb: EBB | null;
  let clients: WebSocket[] = [];
  let cancelRequested = false;
  let unpaused: Promise<void> | null = null;
  let signalUnpause: (() => void) | null = null;
  let motionIdx: number | null = null;
  let currentPlan: Plan | null = null;
  let plotting = false;

  wss.on("connection", (ws) => {
    clients.push(ws);
    ws.on("message", (message) => {
      const msg = JSON.parse(message.toString());
      switch (msg.c) {
        case "ping":
          ws.send(JSON.stringify({ c: "pong" }));
          break;
        case "limp":
          if (ebb) { ebb.disableMotors(); }
          break;
        case "setPenHeight":
          if (ebb) {
            (async() => {
              if (await ebb.supportsSR()) {
                await ebb.setServoPowerTimeout(10000, true);
              }
              await ebb.setPenHeight(msg.p.height, msg.p.rate);
            })();
          }
          break;
      }
    });

    ws.send(JSON.stringify({ c: 'dev', p: getDeviceInfo(ebb, com) }));

    ws.send(JSON.stringify({ c: 'svgio-enabled', p: svgIoApiKey !== '' }));

    ws.send(JSON.stringify({ c: "pause", p: { paused: !!unpaused } }));
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
      await ebb.enableMotors(1); // 16x microstepping, matches defaults from Axidraw
      await ebb.setPenHeight(initialPenHeight, 1000, 1000);
    },
    async executeMotion(motion: Motion, _progress: [number, number]): Promise<void> {
      await ebb.executeMotion(motion);
    },
    async postCancel(initialPenHeight: number): Promise<void> {
      await ebb.setPenHeight(initialPenHeight, 1000);
      await ebb.query('HM,4000'); // HM returns carriage home without 3rd and 4th arguments
    },
    async postPlot(): Promise<void> {
      await ebb.waitUntilMotorsIdle();
      await ebb.disableMotors();
    },
  };

  const simPlotter: Plotter = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async prePlot(_initialPenHeight: number): Promise<void> {
    },
    async executeMotion(motion: Motion, progress: [number, number]): Promise<void> {
      console.log(`Motion ${progress[0] + 1}/${progress[1]}`);
      await new Promise((resolve) => setTimeout(resolve, motion.duration() * 1000));
    },
    async postCancel(_initialPenHeight: number): Promise<void> {
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
      broadcast({ c: "progress", p: { motionIdx } });
      await plotter.executeMotion(motion, [motionIdx, plan.motions.length]);
      if (motion instanceof PenMotion) {
        penIsUp = motion.initialPos < motion.finalPos;
      }
      if (unpaused && penIsUp) {
        await unpaused;
        broadcast({ c: "pause", p: { paused: false } });
      }
      if (cancelRequested) { break; }
      motionIdx += 1;
    }
    motionIdx = null;
    currentPlan = null;
    if (cancelRequested) {
      await plotter.postCancel(firstPenMotion.initialPos);
      broadcast({ c: "cancelled" });
      cancelRequested = false;
    } else {
      broadcast({ c: "finished" });
    }
    await plotter.postPlot();
  }

  return new Promise<http.Server>((resolve) => {
    server.listen(port, () => {
      async function connect() {
        const devices = ebbs(com, hardware);
        for await (const device of devices) {
          ebb = device;
          broadcast({ c: 'dev', p: getDeviceInfo(ebb, com) });
        }
      }
      connect();
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
  return p.manufacturer === "SchmalzHaus" || p.manufacturer === "SchmalzHaus LLC" || (p.vendorId === "04D8" && p.productId === "FD92");
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

async function* ebbs(path?: string, hardware: Hardware = 'v3') {
  while (true) {
    try {
      const com: Com = path || (await _self.waitForEbb()); // use self-import for test mocking
      console.log(`Found EBB at ${com}`);
      const port = await tryOpen(com);
      const closed = new Promise((resolve) => {
        port.addEventListener('disconnect', resolve, { once: true });
      });
      yield new EBB(port, hardware);
      await closed;
      yield null;
      console.error("Lost connection to EBB, reconnecting...");
    } catch (e) {
      console.error(`Error connecting to EBB: ${e.message}`);
      console.error("Retrying in 5 seconds...");
      await sleep(5000);
    }
  }
}

export async function connectEBB(hardware: Hardware, device: string | undefined): Promise<EBB | null> {
  let dev = device;
  if (!device) {
    const ebbs = await listEBBs();
    if (ebbs.length === 0) return null;
    dev = ebbs[0];
  }

  const port = await tryOpen(dev);
  return new EBB(port, hardware);
}
