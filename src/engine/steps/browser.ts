/**
 * Browser / CDP step handlers: navigate, evaluate, click, type, wait,
 * intercept, press, scroll, snapshot, tap.
 *
 * Per-concern module extracted as part of the v0.212 engine restructure.
 * The implementations remain in `src/engine/yaml-runner.ts` (the legacy
 * orchestrator); this module is the stable import boundary that future
 * phases will migrate bodies into.
 */

export {
  stepNavigate as handleNavigate,
  stepEvaluate as handleEvaluate,
  stepClick as handleClick,
  stepType as handleType,
  stepWaitBrowser as handleWait,
  stepIntercept as handleIntercept,
  stepPress as handlePress,
  stepScroll as handleScroll,
  stepSnapshot as handleSnapshot,
  stepTap as handleTap,
  stepExtract as handleExtract,
  type NavigateConfig,
  type EvaluateConfig,
  type ClickConfig,
  type TypeConfig,
  type WaitBrowserConfig,
  type InterceptConfig,
  type TapConfig,
  type ExtractConfig,
} from "../yaml-runner.js";
