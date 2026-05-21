import type { ResolvedAxTarget } from "./desktop-ax-swift.js";
import { buildAxBackgroundInputScript } from "./desktop-ax-background-input-swift.js";

export interface AxBackgroundClickScriptOptions {
  x: number;
  y: number;
  coordinateSpace: "screen" | "window";
  button: number;
  clickCount: number;
  windowNumber?: number;
}

export function buildAxBackgroundClickScript(
  target: ResolvedAxTarget,
  opts: AxBackgroundClickScriptOptions,
): string {
  return buildAxBackgroundInputScript(target, {
    action: "click",
    x: opts.x,
    y: opts.y,
    coordinateSpace: opts.coordinateSpace,
    button: opts.button,
    clickCount: opts.clickCount,
    windowNumber: opts.windowNumber,
  });
}
