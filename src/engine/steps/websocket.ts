import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import { executeWebsocket, type WebsocketStepConfig } from "../websocket.js";

export async function stepWebsocket(
  ctx: PipelineContext,
  config: WebsocketStepConfig,
): Promise<PipelineContext> {
  const resolvedConfig: WebsocketStepConfig = {
    ...config,
    url: evalTemplate(config.url, ctx),
    send: evalTemplate(config.send, ctx),
  };
  const data = await executeWebsocket(resolvedConfig);
  return { ...ctx, data };
}

registerStep("websocket", stepWebsocket as StepHandler);

export { stepWebsocket as handleWebsocket };
