declare module '*.svg' {
  const content: string;
  export default content;
}
declare module 'svgdom';
declare module 'wake-lock';
declare module 'color-interpolate';
declare module 'colormap';

// https://github.com/nornagon/flatten-svg/issues/27
declare module 'flatten-svg' {
  interface Options {
    maxError: number;
  }
  type Point = [number, number];
  interface Line {
    points: Point[];
    stroke?: string;
    groupId?: string;
  }
  export function flattenSVG(svg: SVGElement, options?: Partial<Options>): Line[];

}

declare const IS_WEB: boolean;
