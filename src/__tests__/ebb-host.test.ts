import { describe, expect, test } from "vitest";
import type { SerialChannel } from "../ebb";
import { createEbbHost } from "../ebb-host";
import { AxidrawFast, plan } from "../planning";
import type { HostEvent } from "../serial-worker-rpc";
import { createMockSerialPort, mockSerialPortInstance } from "./mocks/serialport";

const samplePlan = () =>
  plan(
    [
      [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ],
    ],
    AxidrawFast,
  ).serialize();

describe("ebb-host", () => {
  test("runs a plot over a SerialChannel and emits progress + finished", async () => {
    mockSerialPortInstance.clearCommands();
    const channel = createMockSerialPort() as unknown as SerialChannel;
    const events: HostEvent[] = [];

    const done = new Promise<void>((resolve) => {
      const host = createEbbHost(channel, "v3", (event) => {
        events.push(event);
        if (event.kind === "finished" || event.kind === "error") resolve();
      });
      host.handle({ kind: "plot", plan: samplePlan() });
    });

    await done;

    expect(events.find((e) => e.kind === "error")).toBeUndefined();
    expect(events.some((e) => e.kind === "progress")).toBe(true);
    expect(events.some((e) => e.kind === "finished")).toBe(true);
    expect(mockSerialPortInstance.commands).toContain("EM,1,1"); // motors enabled
  });

  test("pauses mid-plot and resumes to completion", async () => {
    mockSerialPortInstance.clearCommands();
    const channel = createMockSerialPort() as unknown as SerialChannel;
    const events: HostEvent[] = [];
    let pausedOnce = false;

    const done = new Promise<void>((resolve) => {
      const host = createEbbHost(channel, "v3", (event) => {
        events.push(event);
        // Request a pause as soon as the plot starts moving...
        if (event.kind === "progress" && !pausedOnce) {
          pausedOnce = true;
          host.handle({ kind: "pause" });
        }
        // ...then resume once the pause has actually taken effect. setTimeout
        // (a macrotask) lets the pause gate park on its resume wait first.
        if (event.kind === "paused" && event.paused) {
          setTimeout(() => host.handle({ kind: "resume" }), 0);
        }
        if (event.kind === "finished" || event.kind === "error") resolve();
      });
      host.handle({ kind: "plot", plan: samplePlan() });
    });

    await done;

    expect(events.find((e) => e.kind === "error")).toBeUndefined();
    expect(events.some((e) => e.kind === "paused" && e.paused === true)).toBe(true);
    expect(events.some((e) => e.kind === "paused" && e.paused === false)).toBe(true);
    expect(events.some((e) => e.kind === "finished")).toBe(true);
  });
});
