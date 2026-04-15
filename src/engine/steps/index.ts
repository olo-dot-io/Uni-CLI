/**
 * Step handler barrel — single side-effect import that registers every
 * built-in pipeline step into `step-registry`.
 *
 * The executor imports this file once; each per-step module self-registers
 * via `registerStep()` at module-load time. Named re-exports below let the
 * deprecated `yaml-runner.ts` shim continue to expose the legacy symbol
 * surface for external callers and tests during the transition.
 */

// --- Per-step modules (self-register on import) ---
export { stepSelect } from "./select.js";
export { stepMap } from "./map.js";
export { stepFilter } from "./filter.js";
export { stepSort, type SortConfig } from "./sort.js";
export { stepLimit } from "./limit.js";
export { stepHtmlToMd } from "./html-to-md.js";
export { stepSet } from "./set.js";
export { stepAppend } from "./append.js";
export { stepIf } from "./if.js";
export { stepEach, type EachConfig } from "./each.js";
export { stepParallel } from "./parallel.js";
export { stepAssert, type AssertConfig } from "./assert.js";
export { stepFetch, type FetchConfig } from "./fetch.js";
export { stepFetchText } from "./fetch-text.js";
export { stepParseRss, type RssConfig } from "./parse-rss.js";
export { stepExec, type ExecConfig } from "./exec.js";
export { stepWriteTemp, type WriteTempConfig } from "./write-temp.js";
export { stepNavigate, type NavigateConfig } from "./navigate.js";
export { stepEvaluate, type EvaluateConfig } from "./evaluate.js";
export { stepClick, type ClickConfig } from "./click.js";
export { stepType, type TypeConfig } from "./type.js";
export { stepWaitBrowser, type WaitBrowserConfig } from "./wait.js";
export { stepIntercept, type InterceptConfig } from "./intercept.js";
export { stepPress } from "./press.js";
export { stepScroll } from "./scroll.js";
export { stepSnapshot } from "./snapshot.js";
export { stepTap, type TapConfig } from "./tap.js";
export { stepExtract, type ExtractConfig } from "./extract.js";
export { stepDownload, type DownloadStepConfig } from "./download.js";
export { stepWebsocket } from "./websocket.js";

// --- Transport-bus dispatch maps (referenced directly by executor.ts) ---
export * from "./cua.js";
export * from "./desktop-ax.js";

// --- Backward-compat `handle*` aliases ---
// Concern shims (transform/browser/control/desktop) re-export the new
// per-step bodies under their legacy `handle*` names.
export {
  handleSelect,
  handleMap,
  handleFilter,
  handleSort,
  handleLimit,
} from "./transform.js";
export {
  handleNavigate,
  handleEvaluate,
  handleClick,
  handleType,
  handleWait,
  handleIntercept,
  handlePress,
  handleScroll,
  handleSnapshot,
  handleTap,
  handleExtract,
} from "./browser.js";
export {
  handleSet,
  handleAppend,
  handleIf,
  handleEach,
  handleParallel,
  handleAssert,
} from "./control.js";
export { handleExec, handleWriteTemp } from "./desktop.js";
export {
  handleFetch,
  handleFetchText,
  handleParseRss,
  handleHtmlToMd,
} from "./fetch.js";
export { stepDownload as handleDownload } from "./download.js";
export { stepWebsocket as handleWebsocket } from "./websocket.js";
