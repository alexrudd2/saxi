/**
 * Front-end for plotter app.
 */
import useComponentSize from "@rehooks/component-size";
import interpolator from "color-interpolate";
import colormap from "colormap";
import React, { type ChangeEvent, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useReducer } from "react";
import { createRoot } from 'react-dom/client';

import { type Path, flattenSVG } from "flatten-svg";
import { PaperSize } from "./paper-size";
import { Device, type MotionData, Plan, type PlanOptions, XYMotion, defaultPlanOptions } from "./planning.js";
import { formatDuration } from "./util.js";

import "./style.css";
import { type DeviceInfo, type BaseDriver, NullDriver, WebSerialDriver, SaxiDriver } from "./drivers";
import type { Hardware } from "./ebb";
import pathJoinRadiusIcon from "./icons/path-joining radius.svg";
import pointJoinRadiusIcon from "./icons/point-joining radius.svg";
import rotateDrawingIcon from "./icons/rotate-drawing.svg";

const defaultVisualizationOptions = {
  penStrokeWidth: 0.5,
  colorPathsByStrokeOrder: false,
};

const defaultSvgIoOptions = {
  enabled: false,
  prompt: '',
  status: '',
  vecType: 'FLAT_VECTOR'
};

const initialState = {
  connected: true,

  paused: false,

  deviceInfo: null as DeviceInfo | null,

  // UI state
  planOptions: defaultPlanOptions,
  visualizationOptions: defaultVisualizationOptions,
  svgIoOptions: defaultSvgIoOptions,

  // Options used to produce the current value of |plan|.
  plannedOptions: null as PlanOptions | null,

  // Info about the currently-loaded SVG.
  paths: null as Path[] | null,
  groupLayers: [] as string[],
  strokeLayers: [] as string[],

  // While a plot is in progress, this will be the index of the current motion.
  progress: (null as number | null),
};

// Update the initial state with previously persisted settings (if present)

const persistedPlanOptions = JSON.parse(window.localStorage.getItem("planOptions") ?? "{}");
initialState.planOptions = { ...initialState.planOptions, ...persistedPlanOptions };
initialState.planOptions.paperSize = new PaperSize(initialState.planOptions.paperSize.size);

type State = typeof initialState;

type Action =
  | { type: "SET_PLAN_OPTION"; value: Partial<State["planOptions"]> }
  | { type: "SET_VISUALIZATION_OPTION"; value: Partial<State["visualizationOptions"]> }
  | { type: "SET_SVGIO_OPTION"; value: Partial<State["svgIoOptions"]> }
  | { type: "SET_DEVICE_INFO"; value: State["deviceInfo"] }
  | { type: "SET_PAUSED"; value: boolean }
  | { type: "SET_PROGRESS"; motionIdx: number | null }
  | { type: "SET_CONNECTED"; connected: boolean }
  | {
    type: "SET_PATHS";
    paths: State["paths"];
    strokeLayers: State["strokeLayers"];
    selectedStrokeLayers: State["planOptions"]["selectedStrokeLayers"];
    groupLayers: State["groupLayers"];
    selectedGroupLayers: State["planOptions"]["selectedGroupLayers"];
    layerMode: State["planOptions"]["layerMode"];
  };

type Dispatcher = React.Dispatch<Action>;
const nullDispatch: Dispatcher = () => null;
const DispatchContext = React.createContext<Dispatcher>(nullDispatch);

/**
 * State machine reducer. Handle actions that update the state.
 * @param state Previous state
 * @param action Message
 * @returns New state
 */
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_PLAN_OPTION":
      return { ...state, planOptions: { ...state.planOptions, ...action.value } };
    case "SET_VISUALIZATION_OPTION":
      return { ...state, visualizationOptions: { ...state.visualizationOptions, ...action.value } };
    case "SET_SVGIO_OPTION":
      return { ...state, svgIoOptions: { ...state.svgIoOptions, ...action.value } };
    case "SET_DEVICE_INFO":
      return { ...state, deviceInfo: action.value };
    case "SET_PAUSED":
      return { ...state, paused: action.value };
    case "SET_PATHS": {
      const { paths, strokeLayers, selectedStrokeLayers, groupLayers, selectedGroupLayers, layerMode } = action;
      return { ...state, paths, groupLayers, strokeLayers, planOptions: { ...state.planOptions, selectedStrokeLayers, selectedGroupLayers, layerMode } };
    }
    case "SET_PROGRESS":
      return { ...state, progress: action.motionIdx };
    case "SET_CONNECTED":
      return { ...state, connected: action.connected };
    default:
      console.warn(`Unrecognized action '${{ action }}'`);
      return state;
  }
}


const usePlan = (paths: Path[] | null, planOptions: PlanOptions) => {
  const [isPlanning, setIsPlanning] = useState(false);
  const [latestPlan, setPlan] = useState<Plan | null>(null);

  function serialize(po: PlanOptions): string {
    return JSON.stringify(po, (_k, v) => v instanceof Set ? [...v] : v);
  }

  function attemptRejigger(previousOptions: PlanOptions, newOptions: PlanOptions, previousPlan: Plan): Plan | null {
    const newOptionsWithOldPenHeights = {
      ...newOptions,
      penUpHeight: previousOptions.penUpHeight,
      penDownHeight: previousOptions.penDownHeight,
    };
    if (serialize(previousOptions) === serialize(newOptionsWithOldPenHeights)) {
      const device = Device(newOptions.hardware);
      // The existing plan should be the same except for penup/pendown heights.
      return previousPlan.withPenHeights(
        device.penPctToPos(newOptions.penUpHeight),
        device.penPctToPos(newOptions.penDownHeight)
      );
    }
    return null;
  }

  const lastPaths = useRef<Path[]>(null);
  const lastPlan = useRef<Plan>(null);
  const lastPlanOptions = useRef<PlanOptions>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(attemptRejigger): handled by planOptions
  useEffect(() => {
    if (!paths) {
      return () => { };
    }
    if (lastPlan.current != null && lastPaths.current === paths) {
      const rejiggered = attemptRejigger(lastPlanOptions.current ?? defaultPlanOptions, planOptions, lastPlan.current);
      if (rejiggered) {
        setPlan(rejiggered);
        lastPlan.current = rejiggered;
        lastPlanOptions.current = planOptions;
        return () => { };
      }
    }
    lastPaths.current = paths;
    const worker = new Worker('background-planner.js');
    setIsPlanning(true);
    console.time("posting to worker");
    worker.postMessage({ paths, planOptions });
    console.timeEnd("posting to worker");
    const listener = (m: Record<'data', MotionData[]>) => {
      console.time("deserializing");
      const deserialized = Plan.deserialize(m.data);
      console.timeEnd("deserializing");
      setPlan(deserialized);
      lastPlan.current = deserialized;
      lastPlanOptions.current = planOptions;
      setIsPlanning(false);
    };
    worker.addEventListener("message", listener);
    return () => {
      worker.removeEventListener("message", listener);
      worker.terminate();
      setIsPlanning(false);
    };
  }, [paths, planOptions]);

  return { isPlanning, plan: latestPlan, setPlan };
};

const setPaths = (paths: Path[]): Action => {
  const strokes = new Set<string>();
  const groups = new Set<string>();
  for (const path of paths) {
    strokes.add(path.stroke);
    groups.add(path.groupId);
  }
  const layerMode = groups.size > 1 ? 'group' : 'stroke';
  const groupLayers = Array.from(groups).sort();
  const strokeLayers = Array.from(strokes).sort();
  return { type: "SET_PATHS", paths, groupLayers, strokeLayers, selectedGroupLayers: new Set(groupLayers), selectedStrokeLayers: new Set(strokeLayers), layerMode };
};

function PenHeight({ state, driver }: { state: State; driver: BaseDriver }) {
  const { penUpHeight, penDownHeight, hardware } = state.planOptions;
  const dispatch = useContext(DispatchContext);
  const setPenUpHeight = (x: number) => dispatch({ type: "SET_PLAN_OPTION", value: { penUpHeight: x } });
  const setPenDownHeight = (x: number) => dispatch({ type: "SET_PLAN_OPTION", value: { penDownHeight: x } });
  const device = Device(hardware);

  const penUp = () => {
    const height = device.penPctToPos(penUpHeight);
    driver.setPenHeight(height, 1000);
  };
  const penDown = () => {
    const height = device.penPctToPos(penDownHeight);
    driver.setPenHeight(height, 1000);
  };
  return <Fragment>
    <div className="flex">
      <label className="pen-label">
        up height (%)
        <input type="number" min="0" max="100"
          value={penUpHeight}
          onChange={(e) => setPenUpHeight(parseInt(e.target.value, 10))}
        />
      </label>
      <label className="pen-label">
        down height (%)
        <input type="number" min="0" max="100"
          value={penDownHeight}
          onChange={(e) => setPenDownHeight(parseInt(e.target.value, 10))}
        />
      </label>
    </div>
    <div className="flex">
      <button type="button" onClick={penUp}>pen up</button>
      <button type="button" onClick={penDown}>pen down</button>
    </div>
  </Fragment>;
}

function HardwareOptions({ state }: { state: State }) {
  return <div>
    <label className="flex-checkbox" title="Motor type (affects pin and power settings)">
      <input
        type="checkbox"
        checked={state.deviceInfo?.hardware === 'brushless'}
        onChange={() => {
          fetch("/change-hardware", { method: "POST" });
        }}
      />
      brushless
    </label>
  </div>;
}

function VisualizationOptions({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);

  return <>
    <label title="Width of lines in preview. Does not affect plot.">
      visualized stroke width (mm)
      <input
        type="number"
        value={state.visualizationOptions.penStrokeWidth}
        min="0"
        max="10"
        step="0.1"
        onChange={(e) => dispatch({ type: "SET_VISUALIZATION_OPTION", value: { penStrokeWidth: Number(e.target.value) } })}
      />
    </label>
    <label className="flex-checkbox" title="Color paths in the preview based on the order in which they will be plotted. Yellow is first, pink is last.">
      <input
        type="checkbox"
        checked={state.visualizationOptions.colorPathsByStrokeOrder}
        onChange={(e) => dispatch({ type: "SET_VISUALIZATION_OPTION", value: { colorPathsByStrokeOrder: !!e.target.checked } })}
      />
      color based on order
    </label>
  </>;
}

function OriginOptions({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);
  const device = Device(state.planOptions.hardware);
  return <div className="flex">
    <label title="Starting and final position of pen when plotting (x)">home x (mm):
      <input
        type="number"
        min="0"
        max={state.planOptions.paperSize.size.x * device.stepsPerMm}
        step="10"
        value={state.planOptions.penHome.x}
        onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { penHome: { x: Number(e.target.value), y: state.planOptions.penHome.y } } })}
      />
    </label>
    <label title="Starting and final position of pen when plotting (y)">home y (mm):
      <input
        type="number"
        min="0"
        max={state.planOptions.paperSize.size.y * device.stepsPerMm}
        step="10"
        value={state.planOptions.penHome.y}
        onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { penHome: { x: state.planOptions.penHome.x, y: Number(e.target.value) } } })}
      />
    </label>
  </div>
}
/**
 * Options to get an AI-Generated SVG image.
 * Use svg.io API: https://api.svg.io/v1/docs
 */
function SvgIoOptions({ state }: { state: State }) {
  const { prompt, vecType, status } = state.svgIoOptions;
  const dispatch = useContext(DispatchContext);
  // call server
  const generateImage = async () => {
    dispatch({ type: "SET_SVGIO_OPTION", value: { status: 'Generating ...' } });
    try {
      const resp = await fetch("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new Blob([JSON.stringify({ prompt, vecType })], { type: 'application/json' }),
      });
      const data = await resp.json();
      if (resp.ok) {
        dispatch({ type: "SET_SVGIO_OPTION", value: { status: 'Loading ...' } });
        // retrieve image
        const imgUrl = data.data[0].svgUrl;
        const imgResp = await fetch(imgUrl);
        const imgData = await imgResp.text();
        // set image contents
        dispatch(setPaths(readSvg(imgData)));
      } else {
        alert(`Error generating image: ${data.message ? data.message : resp.statusText}`);
      }
    } catch (error) {
      console.error(error);
      alert(`Error generating image ${error}`);
    } finally {
      dispatch({ type: "SET_SVGIO_OPTION", value: { status: '' } });
    }
  };
  return <>
    <div>
      <label>Type
        <select value={vecType}
          onChange={(e) => dispatch({ type: "SET_SVGIO_OPTION", value: { vecType: e.target.value } })}>
          <option value={"FLAT_VECTOR"}>Flat</option>
          <option value={"FLAT_VECTOR_OUTLINE"}>Outline</option>
          <option value={"FLAT_VECTOR_SILHOUETTE"}>Silhouette</option>
          <option value={"FLAT_VECTOR_ONE_LINE_ART"}>One Line Art</option>
          <option value={"FLAT_VECTOR_LINE_ART"}>Line Art</option>
        </select>
      </label>
      <label title="prompt">Prompt
        <textarea value={prompt}
          onChange={(e) => dispatch({ type: "SET_SVGIO_OPTION", value: { prompt: e.target.value } })}>
        </textarea>
      </label>
    </div>
    {prompt !== ''
      ? <div>
        {status ? <span>{status}</span> : <button type="button" onClick={generateImage}>Generate!</button>}
      </div>
      : ''}
  </>;
}

function SwapPaperSizesButton({ onClick }: { onClick: () => void }) {
  const handleKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); // Prevent scrolling with spacebar
      onClick();
    }
  };
  return <svg
    className="paper-sizes__swap"
    xmlns="http://www.w3.org/2000/svg"
    width="14.05"
    height="11.46"
    viewBox="0 0 14.05 11.46"
    onKeyDown={handleKeyDown}
    // biome-ignore lint/a11y/noNoninteractiveTabindex: no need for a div wrapper
    tabIndex={0}
    onClick={onClick}
  >
    <title>swap width and height</title>
    <g>
      <polygon points="14.05 3.04 8.79 0 8.79 1.78 1.38 1.78 1.38 4.29 8.79 4.29 8.79 6.08 14.05 3.04" />
      <polygon points="0 8.43 5.26 11.46 5.26 9.68 12.67 9.68 12.67 7.17 5.26 7.17 5.26 5.39 0 8.43" />
    </g>
  </svg>;
}

function PaperConfig({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);
  const landscape = state.planOptions.paperSize.isLandscape;
  function setPaperSize(e: ChangeEvent) {
    const name = (e.target as HTMLInputElement).value;
    if (name !== "Custom") {
      const ps = PaperSize.standard[name][landscape ? "landscape" : "portrait"];
      dispatch({ type: "SET_PLAN_OPTION", value: { paperSize: ps } });
    }
  }
  function setCustomPaperSize(x: number, y: number) {
    dispatch({ type: "SET_PLAN_OPTION", value: { paperSize: new PaperSize({ x, y }) } });
  }
  const { paperSize } = state.planOptions;
  const paperSizeName = Object.keys(PaperSize.standard).find((psName) => {
    const ps = PaperSize.standard[psName].size;
    return (ps.x === paperSize.size.x && ps.y === paperSize.size.y)
      || (ps.y === paperSize.size.x && ps.x === paperSize.size.y);
  }) || "Custom";
  return <div>
    <select
      value={paperSizeName}
      onChange={setPaperSize}
    >
      {Object.keys(PaperSize.standard).map((name) =>
        <option key={name}>{name}</option>
      )}
      <option>Custom</option>
    </select>
    <div className="paper-sizes">
      <label className="paper-label">
        width (mm)
        <input
          type="number"
          value={paperSize.size.x}
          onChange={(e) => setCustomPaperSize(Number(e.target.value), paperSize.size.y)}
        />
      </label>
      <SwapPaperSizesButton onClick={() => {
        dispatch({
          type: "SET_PLAN_OPTION",
          value: { paperSize: paperSize.isLandscape ? paperSize.portrait : paperSize.landscape }
        });
      }} />
      <label className="paper-label">
        height (mm)
        <input
          type="number"
          value={paperSize.size.y}
          onChange={(e) => setCustomPaperSize(paperSize.size.x, Number(e.target.value))}
        />
      </label>
    </div>
    <div>
      <label>
        rotate drawing (degrees)
        <div className="horizontal-labels">
          <img src={rotateDrawingIcon} alt="rotate drawing (degrees)" />
          <input type="number" min="-90" step="90" max="360" placeholder="0" value={state.planOptions.rotateDrawing}
            onInput={(e) => {
              const value = (e.target as HTMLInputElement).value;
              if (Number(value) < 0) { (e.target as HTMLInputElement).value = "270"; }
              if (Number(value) > 270) { (e.target as HTMLInputElement).value = "0"; }
            }}
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { rotateDrawing: Number(e.target.value) } })} />
        </div>
      </label>
    </div>
    <label>
      margin (mm)
      <input
        type="number"
        value={state.planOptions.marginMm}
        min="0"
        max={Math.min(paperSize.size.x / 2, paperSize.size.y / 2)}
        onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { marginMm: Number(e.target.value) } })}
      />
    </label>
  </div>;
}

function MotorControl({ driver }: { driver: BaseDriver }) {
  return <div>
    <button type="button" onClick={() => driver.limp()}>disengage motors</button>
  </div>;
}

function PlanStatistics({ plan }: { plan: Plan | null }) {
  return <div className="duration">
    <div>Duration</div>
    <div><strong>{plan?.duration ? formatDuration(plan.duration()) : "-"}</strong></div>
  </div>;
}

function TimeLeft({ plan, progress, currentMotionStartedTime, paused }: {
  plan: Plan | null;
  progress: number | null;
  currentMotionStartedTime: Date;
  paused: boolean;
}) {
  const [_, setTime] = useState(new Date());

  // Interval that ticks every second to rerender
  // and recalculate time remaining for long motions
  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date());
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  if (!plan || !plan.duration || progress === null || paused) {
    return null;
  }

  const currentMotionTimeSpent = (Date.now()- currentMotionStartedTime.getTime()) / 1000;
  const duration = plan.duration(progress);
  return <div className="duration">
    <div className="time-remaining-label">Time remaining</div>
    <div><strong>{formatDuration(duration - currentMotionTimeSpent)}</strong></div>
  </div>;
}

function PlanPreview(
  { state, previewSize, plan }: {
    state: State;
    previewSize: { width: number; height: number };
    plan: Plan | null;
  }
) {
  const ps = state.planOptions.paperSize;
  const device = Device(state.planOptions.hardware);
  const strokeWidth = state.visualizationOptions.penStrokeWidth * device.stepsPerMm;
  const colorPathsByStrokeOrder = state.visualizationOptions.colorPathsByStrokeOrder;
  const memoizedPlanPreview = useMemo(() => {
    if (plan) {
      const palette = colorPathsByStrokeOrder
        ? interpolator(colormap({ colormap: 'spring' }))
        : () => 'rgba(0, 0, 0, 0.8)';
      const lines = plan.motions
        .filter((m) => m instanceof XYMotion)
        .map((m) => m.blocks.map((b) => b.p1).concat([m.p2]))  // Map each XYMotion to its start/end points
        .filter((m) => m.length);
      return <g transform={`scale(${1 / device.stepsPerMm})`}>
        <title>Pen home</title>
        <text x={lines[0][0].x} y={lines[0][0].y}
          fontSize="40"
          textAnchor="middle" dominantBaseline="middle"
        >ꚛ</text>
        {lines.map((line, i) =>
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: the paths are not changed elsewhere
            key={i}
            d={line.reduce((m, { x, y }, j) => `${m}${j === 0 ? "M" : "L"}${x} ${y}`, "")}
            style={i % 2 === 0 ? { stroke: "rgba(0, 0, 0, 0.3)", strokeWidth: 0.5 } : { stroke: palette(1 - i / lines.length), strokeWidth }}
          />
        )}
      </g>;
    }
    return null;
  }, [plan, strokeWidth, colorPathsByStrokeOrder, device.stepsPerMm]);

  // w/h of svg.
  // first try scaling so that h = area.h. if w < area.w, then ok.
  // otherwise, scale so that w = area.w.
  const { width, height } = ps.size.x / ps.size.y * previewSize.height <= previewSize.width
    ? { width: ps.size.x / ps.size.y * previewSize.height, height: previewSize.height }
    : { height: ps.size.y / ps.size.x * previewSize.width, width: previewSize.width };

  const [microprogress, setMicroprogress] = useState(0);
  useLayoutEffect(() => {
    let rafHandle: number;
    let cancelled = false;
    if (state.progress != null) {
      const startingTime = Date.now();
      const updateProgress = () => {
        if (cancelled) { return; }
        setMicroprogress(Date.now() - startingTime);
        rafHandle = requestAnimationFrame(updateProgress);
      };
      updateProgress();
    }
    return () => {
      cancelled = true;
      if (rafHandle != null) {
        cancelAnimationFrame(rafHandle);
      }
      setMicroprogress(0);
    };
  }, [state.progress]);

  let progressIndicator = <></>;
  if (state.progress != null && plan != null) {
    const motion = plan.motion(state.progress);
    const pos = motion instanceof XYMotion
      ? motion.instant(Math.min(microprogress / 1000, motion.duration())).p
      : (plan.motion(state.progress - 1) as XYMotion).p2;
    const posXMm = pos.x / device.stepsPerMm;
    const posYMm = pos.y / device.stepsPerMm;
    progressIndicator =
      <svg
        width={width * 2}
        height={height * 2}
        viewBox={`${-width} ${-height} ${width * 2} ${height * 2}`}
        style={{
          transform: "translateZ(0.001px) " +
            `translate(${-width}px, ${-height}px) ` +
            `translate(${posXMm / ps.size.x * 50}%,${posYMm / ps.size.y * 50}%)`
        }}
      >
        <title>Progress percentage bar</title>
        <g>
          <path
            d={`M-${width} 0l${width * 2} 0M0 -${height}l0 ${height * 2}`}
            style={{ stroke: "rgba(222, 114, 114, 0.6)", strokeWidth: 1 }}
          />
          <path
            d="M-10 0l20 0M0 -10l0 20"
            style={{ stroke: "rgba(222, 114, 114, 1)", strokeWidth: 2 }}
          />
        </g>
      </svg>;
  }
  const margins = <g>
    <rect
      x={state.planOptions.marginMm}
      y={state.planOptions.marginMm}
      width={(ps.size.x - state.planOptions.marginMm * 2)}
      height={(ps.size.y - state.planOptions.marginMm * 2)}
      fill="none"
      stroke="black"
      strokeWidth="0.1"
      strokeDasharray="1,1"
    />
  </g>;
  return <div className="preview">
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${ps.size.x} ${ps.size.y}`}
    >
      <title>Plot preview</title>
      {memoizedPlanPreview}
      {margins}
    </svg>
    {progressIndicator}
  </div>;
}

function PlanLoader(
  { isLoadingFile, isPlanning }: {
    isLoadingFile: boolean;
    isPlanning: boolean;
  }
) {
  if (isLoadingFile || isPlanning) {
    return <div className="preview-loader">
      {isLoadingFile ? 'Loading file...' : 'Replanning...'}
    </div>;
  }

  return null;
}

function LayerSelector({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);
  const layers = state.planOptions.layerMode === 'group' ? state.groupLayers : state.strokeLayers;
  const selectedLayers = state.planOptions.layerMode === 'group' ? state.planOptions.selectedGroupLayers : state.planOptions.selectedStrokeLayers;
  if (layers.length <= 1) { return null; }
  const layersChanged = state.planOptions.layerMode === 'group' ?
    (e: ChangeEvent) => {
      const selectedLayers = new Set([...(e.target as HTMLSelectElement).selectedOptions].map((o) => o.value));
      dispatch({ type: "SET_PLAN_OPTION", value: { selectedGroupLayers: selectedLayers } });
    } :
    (e: ChangeEvent) => {
      const selectedLayers = new Set([...(e.target as HTMLSelectElement).selectedOptions].map((o) => o.value));
      dispatch({ type: "SET_PLAN_OPTION", value: { selectedStrokeLayers: selectedLayers } });
    };
  return <div>
    <label>
      layers
      <select
        className="layer-select"
        multiple={true}
        value={[...selectedLayers]}
        onChange={layersChanged}
        size={3}
        disabled={state.progress != null}
      >
        {layers.map((layer) => <option key={layer}>{layer}</option>)}
      </select>
    </label>
  </div>;
}

function PlotButtons(
  { state, plan, isPlanning, driver }: {
    state: State;
    plan: Plan | null;
    isPlanning: boolean;
    driver: BaseDriver;
  }
) {
  function cancel() {
    driver.cancel();
  }
  function pause() {
    driver.pause();
  }
  function resume() {
    driver.resume();
  }
  function plot(plan: Plan) {
    driver.plot(plan);
  }

  return <div>
    {
      isPlanning
        ? <button
          type="button"
          className="replan-button"
          disabled={true}>
          Replanning...
        </button>
        : <button
          type="button"
          className={`plot-button ${state.progress != null ? "plot-button--plotting" : ""}`}
          disabled={plan == null || state.progress != null}
          onClick={() => plan && plot(plan)}>
          {plan && state.progress != null ? "Plotting..." : "Plot"}
        </button>
    }
    <div className={"button-row"}>
      <button
        type="button"
        className={`cancel-button ${state.progress != null ? "cancel-button--active" : ""}`}
        onClick={state.paused ? resume : pause}
        disabled={plan == null || state.progress == null}
      >{state.paused ? "Resume" : "Pause"}</button>
      <button type="button"
        className={`cancel-button ${state.progress != null ? "cancel-button--active" : ""}`}
        onClick={cancel}
        disabled={plan == null || state.progress == null}
      >Cancel</button>
    </div>
  </div>;
}

function ResetToDefaultsButton() {
  const dispatch = useContext(DispatchContext);
  const onClick = () => {
    // Clear all user settings that have been saved and reset to the defaults
    window.localStorage.removeItem("planOptions");
    dispatch({ type: "SET_PLAN_OPTION", value: { ...defaultPlanOptions } });
  };

  return <button type="reset" className="button-link" onClick={onClick}>reset all options</button>;

}

function PlanConfig({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);
  return <div>
    <form>
      <label className="flex-checkbox" title="Re-order paths to minimize pen-up travel time">
        <input
          type="checkbox"
          checked={state.planOptions.sortPaths}
          onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { sortPaths: !!e.target.checked } })}
        />
        sort paths
      </label>
      <label className="flex-checkbox" title="Split into layers according to group ID, instead of stroke">
        <input
          type="checkbox"
          checked={state.planOptions.layerMode === 'group'}
          onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { layerMode: e.target.checked ? 'group' : 'stroke' } })}
        />
        layer by group
      </label>
      <label className="flex-checkbox" title="Re-scale and position the image to fit on the page">
        <input
          type="checkbox"
          checked={state.planOptions.fitPage}
          onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { fitPage: !!e.target.checked } })}
        />
        fit page
      </label>
      {!state.planOptions.fitPage ?
        <label className="flex-checkbox" title="Remove lines that fall outside the margins">
          <input
            type="checkbox"
            checked={state.planOptions.cropToMargins}
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { cropToMargins: !!e.target.checked } })}
          />
          crop to margins
        </label>
        : null}
    </form>
    <div className="horizontal-labels">

      <label title="point-joining radius (mm)" >
        <img src={pointJoinRadiusIcon} alt="point-joining radius (mm)" />
        <input
          type="number"
          value={state.planOptions.pointJoinRadius}
          step="0.1"
          min="0"
          onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { pointJoinRadius: Number(e.target.value) } })}
        />
      </label>
      <label title="path-joining radius (mm)">
        <img src={pathJoinRadiusIcon} alt="path-joining radius (mm)" />
        <input
          type="number"
          value={state.planOptions.pathJoinRadius}
          step="0.1"
          min="0"
          onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { pathJoinRadius: Number(e.target.value) } })}
        />
      </label>
    </div>
    <div>
      <label title="Remove paths that are shorter than this length (in mm)">
        minimum path length
        <input
          type="number"
          value={state.planOptions.minimumPathLength}
          step="0.1"
          min="0"
          onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { minimumPathLength: Number(e.target.value) } })}
        />
      </label>
      <div className="flex">
        <label title="Acceleration when the pen is down (in mm/s^2)">
          down acc. (mm/s<sup>2</sup>)
          <input
            type="number"
            value={state.planOptions.penDownAcceleration}
            step="0.1"
            min="0"
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { penDownAcceleration: Number(e.target.value) } })}
          />
        </label>
        <label title="Maximum velocity when the pen is down (in mm/s)">
          down max vel. (mm/s)
          <input
            type="number"
            value={state.planOptions.penDownMaxVelocity}
            step="0.1"
            min="0"
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { penDownMaxVelocity: Number(e.target.value) } })}
          />
        </label>
      </div>
      <label>
        cornering factor
        <input
          type="number"
          value={state.planOptions.penDownCorneringFactor}
          step="0.01"
          min="0"
          onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { penDownCorneringFactor: Number(e.target.value) } })}
        />
      </label>
      <div className="flex">
        <label title="Acceleration when the pen is up (in mm/s^2)">
          up acc. (mm/s<sup>2</sup>)
          <input
            type="number"
            value={state.planOptions.penUpAcceleration}
            step="0.1"
            min="0"
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { penUpAcceleration: Number(e.target.value) } })}
          />
        </label>
        <label title="Maximum velocity when the pen is up (in mm/s)">
          up max vel. (mm/s)
          <input
            type="number"
            value={state.planOptions.penUpMaxVelocity}
            step="0.1"
            min="0"
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { penUpMaxVelocity: Number(e.target.value) } })}
          />
        </label>
      </div>
      <div className="flex">
        <label title="How long the pen takes to lift (in seconds)">
          pen lift duration (s)
          <input
            type="number"
            value={state.planOptions.penLiftDuration}
            step="0.01"
            min="0"
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { penLiftDuration: Number(e.target.value) } })}
          />
        </label>
        <label title="How long the pen takes to drop (in seconds)">
          pen drop duration (s)
          <input
            type="number"
            value={state.planOptions.penDropDuration}
            step="0.01"
            min="0"
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { penDropDuration: Number(e.target.value) } })}
          />
        </label>
      </div>
    </div>
  </div>;
}

type PortSelectorProps = {
  driver: BaseDriver;
  setDriver: (driver: BaseDriver) => void;
  hardware: Hardware;
}

function PortSelector({ driver, setDriver, hardware }: PortSelectorProps) {
  const [initializing, setInitializing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: setDriver is stable
  useEffect(() => {
    (async () => {
      if (!(driver instanceof NullDriver)) { return } // Already connected
      setInitializing(true);
      try {
        const ports = await navigator.serial.getPorts();  // re-connect to previously established connection
        const port = ports[0];
        if (port) {
          console.log('connecting to', port);
          // get the first
          setDriver(await WebSerialDriver.connect(port, hardware));
        }
      } finally {
        setInitializing(false);
      }
    })();
  }, [driver, hardware]);
  return <>
    {(!driver.connected) ? null : `Connected to ${driver.name()}`}
     <button
       type="button"
       disabled={initializing}
       onClick={async () => {
        setInitializing(true);
         try {
           const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x04D8, usbProductId: 0xFD92 }] });
           setDriver(await WebSerialDriver.connect(port, hardware));
         } catch (e) {
           alert(`Failed to connect to serial device: ${e.message}`);
           console.error(e);
         } finally {
          setInitializing(false);
         }
       }}
     >
      {initializing ? "Connecting..." : ((!driver.connected) ? "Connect" : "Change port")}
     </button>
  </>;
}

function Root() {
  const [driver, setDriver] = useState<BaseDriver>(new NullDriver());
  const [isDriverConnected, setIsDriverConnected] = useState(false);
  useEffect(() => {
    if (isDriverConnected) return;
    if (IS_WEB) return;
    setDriver(SaxiDriver.connect());
    setIsDriverConnected(true);
  }, [isDriverConnected]);

  const [state, dispatch] = useReducer(reducer, initialState);
  const { isPlanning, plan, setPlan } = usePlan(state.paths, state.planOptions);
  const [isLoadingFile, setIsLoadingFile] = useState(false);

  useEffect(() => {
    window.localStorage.setItem("planOptions", JSON.stringify(state.planOptions));
  }, [state.planOptions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(setPlan): React setters are stable
  // biome-ignore lint/correctness/useExhaustiveDependencies(state.planOptions): planOptions is managed elsewhere
  useEffect(() => {
    if (driver == null) return;
    driver.onprogress = (motionIdx: number) => {
      dispatch({ type: "SET_PROGRESS", motionIdx });
    };
    driver.oncancelled = driver.onfinished = () => {
      dispatch({ type: "SET_PROGRESS", motionIdx: null });
    };
    driver.ondevinfo = (devInfo: DeviceInfo) => {
      dispatch({ type: "SET_DEVICE_INFO", value: devInfo });
      dispatch({ type: "SET_PLAN_OPTION", value: { ...state.planOptions, hardware: devInfo.hardware } });
    };
    driver.onpause = (paused: boolean) => {
      dispatch({ type: "SET_PAUSED", value: paused });
    };
    driver.onplan = (plan: Plan) => {
      setPlan(plan);
    };
    if (driver instanceof SaxiDriver) {
      driver.svgioEnabled = (enabled: boolean) => {
        dispatch({ type: "SET_SVGIO_OPTION", value: { enabled } });
      };
    }
  }, [driver]);

  useEffect(() => { // poll the driver so React notices connection changes
    const interval = setInterval(() => {
      if (state.connected !== driver.connected) {
        dispatch({ type: "SET_CONNECTED", connected: driver.connected });
      }
    }, 100);
    return () => clearInterval(interval);
  }, [driver, state.connected]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(setPlan): React setters are stable
  useEffect(() => {
    // Called when the user drags and drops the image
    const ondrop = (e: DragEvent) => {
      e.preventDefault();
      document.body.classList.remove("dragover");
      if (e.dataTransfer === null) { return; }
      // Open the SVG file the user dragged into the area
      const item = e.dataTransfer.items[0];
      const file = item.getAsFile();
      if (file === null) { return; }
      const reader = new FileReader();
      setIsLoadingFile(true);
      setPlan(null);
      reader.onload = () => {
        // Convert SVG to Plan an path instructions
        dispatch(setPaths(readSvg(reader.result as string)));
        setIsLoadingFile(false);
      };
      reader.onerror = () => {
        setIsLoadingFile(false);
      };
      reader.readAsText(file);
    };
    const ondragover = (e: DragEvent) => {
      e.preventDefault();
      document.body.classList.add("dragover");
    };
    const ondragleave = (e: DragEvent) => {
      e.preventDefault();
      document.body.classList.remove("dragover");
    };
    const onpaste = (e: ClipboardEvent) => {
      e.clipboardData?.items[0].getAsString((s) => {
        dispatch(setPaths(readSvg(s)));
      });
    };
    document.body.addEventListener("drop", ondrop);
    document.body.addEventListener("dragover", ondragover);
    document.body.addEventListener("dragleave", ondragleave);
    document.addEventListener("paste", onpaste);
    return () => {
      document.body.removeEventListener("drop", ondrop);
      document.body.removeEventListener("dragover", ondragover);
      document.body.removeEventListener("dragleave", ondragleave);
      document.removeEventListener("paste", onpaste);
    };
  }, []);

  // Each time new motion is started, save the start time
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentMotionStartedTime should be re-set with each motion
  const currentMotionStartedTime = useMemo(() => {
    return new Date();
  }, [state.progress, plan, state.paused]);

  const previewArea = useRef(null);
  const previewSize = useComponentSize(previewArea);
  const showDragTarget = !plan && !isLoadingFile && !isPlanning;

  return <DispatchContext.Provider value={dispatch}>
    <div className={`root ${state.connected ? "connected" : "disconnected"}`}>
      <div className="control-panel">
        <div className={"saxi-title red"} title={state.deviceInfo ? state.deviceInfo.path : undefined}>
          <span className="red reg">s</span><span className="teal">axi</span>
        </div>
        {!state.connected && <div className="info-disconnected">disconnected</div>}
        {IS_WEB && <PortSelector driver={driver} setDriver={setDriver} hardware={state.deviceInfo?.hardware ?? 'v3'} />}
        <div className="section-header">pen</div>
        <div className="section-body">
          <PenHeight state={state} driver={driver} />
          <MotorControl driver={driver} />
          <HardwareOptions state={state} />
          <ResetToDefaultsButton />
        </div>
        <div className="section-header">paper</div>
        <div className="section-body">
          <PaperConfig state={state} />
          <LayerSelector state={state} />
        </div>
        <details>
          <summary className="section-header">more</summary>
          <div className="section-body">
            <PlanConfig state={state} />
            <OriginOptions state={state} />
            <VisualizationOptions state={state} />
          </div>
        </details>
        {state.svgIoOptions.enabled &&
          (<details>
            <summary className="section-header">AI</summary>
            <div className="section-body">
              <SvgIoOptions state={state} />
            </div>
          </details>
        )}
        <div className="spacer" />
        <div className="control-panel-bottom">
          <div className="section-header">plot</div>
          <div className="section-body section-body__plot">
            <PlanStatistics plan={plan} />
            <TimeLeft
              plan={plan}
              progress={state.progress}
              currentMotionStartedTime={currentMotionStartedTime}
              paused={state.paused}
            />
            <PlotButtons plan={plan} isPlanning={isPlanning} state={state} driver={driver} />
          </div>
        </div>
      </div>
      <div className="preview-area" ref={previewArea}>
        <PlanPreview
          state={state}
          previewSize={{ width: Math.max(0, previewSize.width - 40), height: Math.max(0, previewSize.height - 40) }}
          plan={plan}
        />
        <PlanLoader isPlanning={isPlanning} isLoadingFile={isLoadingFile} />
        {showDragTarget ? <DragTarget /> : null}
      </div>
    </div>
  </DispatchContext.Provider>;
}

function DragTarget() {
  return <div className="drag-target">
    <div className="drag-target-message">
      Drag SVG here
    </div>
  </div>;
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
// biome-ignore lint/style/noNonNullAssertion: static element
createRoot(document.getElementById("app")!).render(<Root />);

/**
 * Read an SVG string and transform it to a list of Path.
 * @param svgString Raw SVG String
 * @returns A list of obj 
 */
function readSvg(svgString: string): Path[] {
  // create a DOM object for the SVG
  const div = document.createElement("div");
  div.style.position = "absolute";
  div.style.left = "99999px";
  document.body.appendChild(div);
  try {
    div.innerHTML = svgString;
    const svg = div.querySelector("svg") as SVGSVGElement;
    const paths = flattenSVG(svg);
    return paths;
  } finally {
    div.remove();
  }
}
