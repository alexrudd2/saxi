declare module 'svgdom';
declare module 'wake-lock';
declare module 'color-interpolate';
declare module 'colormap';
declare module '*.svg';

// https://github.com/nornagon/flatten-svg/issues/27
// since we have to define the types anyways, we can rename them
declare module 'flatten-svg' {
  interface Options {
    maxError: number;
  }
  type Vec2 = { x: number, y: number }; // corresponds to Point
  interface Path { // corresponds to Line
    points: Vec2[];
    stroke: string;
    groupId: string;
  }
  export function flattenSVG(svg: SVGElement, options?: Partial<Options>): Path[];

}

declare const IS_WEB: boolean;
