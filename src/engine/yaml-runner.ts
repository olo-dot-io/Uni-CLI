/**
 * @deprecated since v0.213 — import from ./executor.js (runPipeline,
 * PipelineError, assertSafeRequestUrl), ./step-registry.js (registerStep,
 * StepHandler), ./template.js (evalExpression, PIPE_FILTERS), or the
 * per-step file under ./steps/. This shim is removed in v0.214.
 */
// prettier-ignore
export { runPipeline, PipelineError, assertSafeRequestUrl, type PipelineContext, type PipelineOptions, __resetTransportBusForTests } from "./executor.js";
// prettier-ignore
export { registerStep, getStep, listSteps, type StepHandler } from "./step-registry.js";
// prettier-ignore
export { PIPE_FILTERS, evalExpression, buildScope } from "./template.js";
// prettier-ignore
export { stepFetch, stepFetchText, stepParseRss, stepHtmlToMd, stepSelect, stepMap, stepFilter, stepSort, stepLimit, stepExec, stepWriteTemp, stepNavigate, stepEvaluate, stepClick, stepType, stepWaitBrowser, stepIntercept, stepPress, stepScroll, stepSnapshot, stepTap, stepExtract, stepSet, stepAppend, stepIf, stepEach, stepParallel, stepAssert, stepDownload, stepWebsocket, type FetchConfig, type RssConfig, type SortConfig, type ExecConfig, type WriteTempConfig, type NavigateConfig, type EvaluateConfig, type ClickConfig, type TypeConfig, type WaitBrowserConfig, type InterceptConfig, type TapConfig, type ExtractConfig, type AssertConfig, type EachConfig, type DownloadStepConfig } from "./steps/index.js";
if (process.env.UNICLI_DEBUG === "1") {
  process.stderr.write(
    "[unicli] yaml-runner.ts is deprecated; import from ./executor.js or ./steps/\n",
  );
}
