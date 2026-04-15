/**
 * Browser / CDP step handlers (re-export shim) — kept for backward compat
 * with code expecting `handleNavigate`, `handleClick`, etc. Real bodies
 * live in per-step files now.
 */

export {
  stepNavigate as handleNavigate,
  type NavigateConfig,
} from "./navigate.js";
export {
  stepEvaluate as handleEvaluate,
  type EvaluateConfig,
} from "./evaluate.js";
export { stepClick as handleClick, type ClickConfig } from "./click.js";
export { stepType as handleType, type TypeConfig } from "./type.js";
export {
  stepWaitBrowser as handleWait,
  type WaitBrowserConfig,
} from "./wait.js";
export {
  stepIntercept as handleIntercept,
  type InterceptConfig,
} from "./intercept.js";
export { stepPress as handlePress } from "./press.js";
export { stepScroll as handleScroll } from "./scroll.js";
export { stepSnapshot as handleSnapshot } from "./snapshot.js";
export { stepTap as handleTap, type TapConfig } from "./tap.js";
export { stepExtract as handleExtract, type ExtractConfig } from "./extract.js";
