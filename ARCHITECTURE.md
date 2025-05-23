# Architecture

The application has two main operating modes:

- `IS_WEB` not set (default), where the javascript client in the browser talks to an Express server (HTTP + websocket), which forwards commands to an AxiDraw using NodeSerialPort.  This will work for most use cases.
- `IS_WEB=TRUE`, where only static files are served. The javascript client talks directly to the EBB using the WebSerial API. This mode is ideal for hosting on a public site where people can access it from their browser to control an AxiDraw machine connected to their computer.

There's a third operation mode, which is sending individual instructions to the AxiDraw machine, without displaying any web client or starting a web server. This can be used for development and testing.

## Important Files

- [`src/cli.ts`](src/cli.ts) The main entry point. When called with no commands, it starts an Express Server that serves the compiled static code. Alternatively, it can be used to execute individual instructions on the Axi machine.
- [`src/server.ts](src/server.ts) The Express Server definition. It serves these main paths:
  - `/` The static files for compiled UI code.
  - `/plot` To start plotting.
  - `/cancel` To cancel the current plotting task.
  - `/pause` and `/resume`
  - It also keeps a WebSocket connection with the UI to track drawing progress, and receive some motion instructions.
- [`src/ui.tsx`](src/ui.tsx) The bulk of the React UI, handles the logic for rendering and interaction. It uses the `BaseDriver` interface to pass instructions to the Express Server. Important parts are:
  - `Root` contains all other components, the state of the UI, and handles most of the interaction events, including the loading of a new SVG.
  - The control panel has all the config settings, grouped in components: `PenHeight`, `MotorControl`, `PaperConfig`, etc.
  - `reducer` manages state and handles the UI interaction flow - i.e. disabling/enabling controls when plotting.
- [`src/drivers.ts`](src/drivers.ts) Interface between UI and Axi machine.  `SaxiDriver`, which uses an intermediate server and NodeSerialPort, and `WebSerialDriver`, which uses WebSerial, are both implementations of `BaseDriver`.
- [`src/planning.ts`](src/planning.ts) Most of the logic of interpreting an SVG-like object and converting it into a `Plan` of machine instructions to execute. It defines attribute interfaces that are used both in the UI and the server.
- [`src/massager.ts`](src/massager.ts) Some higher-level transformations that can be done like rotating.

## When dropping an SVG on the Drawing Area

On `ui.tsx`:

1. The event `ondrop` is triggered on the `Root` component.
2. It reads the file as a string, and calls the `readSvg` function.
3. The `readSvg` function parses the text as an DOM object to call the `flatten-svg` library. It converts it into a list of `Line`s.
4. Each line is converted to `Path` - a list of `Vec2`.
5. The `setPaths` function assigns the result in `paths`, and makes a groups of strokes by layers.
6. Then the paths are converted into a `Plan` - parameterized by the `PlanOptions` on the `usePlan` function`.
  a. It spawns a background `Worker` in `background-planner.ts`
  b. It calls `replan` on `massager.ts` to apply higher level tranformations.
  b. Which in turns calls `plan` on `planning.ts` to transform a list of lines and parameters into a list of `PenMotion`.
7. The plan gets stored in the state of the `Root` component.
