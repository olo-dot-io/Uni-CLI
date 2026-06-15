import { getBus } from "../../transport/bus.js";
import {
  executeComputeAction,
  type ComputeActionExecution,
} from "../../compute/action-execution.js";
import { captureComputeContext } from "../../compute/capture.js";
import {
  copyReferenceMarkupToClipboard,
  saveComputeCaptureReference,
} from "../../compute/capture-reference.js";
import { createPlatformComputeOverlayProvider } from "../../compute/platform-overlays.js";
import { buildComputeActionVisualEvidence } from "../../compute/visual-timeline.js";
import {
  buildComputeInputSchema,
  getComputeCommandContract,
} from "../../compute/contracts.js";
import { err, exitCodeFor } from "../../core/envelope.js";
import type { ActionResult } from "../../transport/types.js";
import type { McpToolResult } from "../dispatch.js";
import type { McpPrompt, McpTool } from "../tools.js";

type Params = Record<string, unknown>;

interface ToolDef {
  suffix: string;
  description: string;
  kind: string;
  inputSchema: McpTool["inputSchema"];
  readOnly?: boolean;
  transform?: (input: Params) => Params;
  handler?: (input: Params, def: ToolDef) => Promise<McpToolResult>;
}

const DEFINITIONS: ToolDef[] = [
  computeToolDef("apps"),
  computeToolDef("windows"),
  {
    ...computeToolDef("capture"),
    handler: async (input, def) => {
      const format = readCaptureFormat(input.format);
      if (!format.ok) {
        return actionResultToMcp(
          err({
            transport: "subprocess",
            step: 0,
            action: "compute_capture",
            reason: `invalid snapshot format: ${format.value}`,
            suggestion: "use format compact, tree, or json",
            minimum_capability: "compute.capture",
            exit_code: exitCodeFor("usage_error"),
          }),
          def,
        );
      }
      const result = await captureComputeContext(getBus(), {
        ...(typeof input.app === "string" ? { app: input.app } : {}),
        ...(typeof input.include === "string"
          ? { include: input.include }
          : {}),
        format: format.value,
        maxDepth:
          typeof input.maxDepth === "number" && Number.isFinite(input.maxDepth)
            ? input.maxDepth
            : 64,
        ...(typeof input.screenshotPath === "string"
          ? { screenshotPath: input.screenshotPath }
          : {}),
      });
      const shouldSaveReference =
        input.saveReference === true || input.copyReference === true;
      if (!result.ok || !shouldSaveReference) {
        return actionResultToMcp(result, def);
      }
      const referenceRoot =
        typeof input.referenceRoot === "string" && input.referenceRoot
          ? input.referenceRoot
          : undefined;
      const reference = await saveComputeCaptureReference(
        result.data,
        referenceRoot ? { rootDir: referenceRoot } : {},
      );
      if (input.copyReference === true) {
        try {
          await copyReferenceMarkupToClipboard(reference.markup);
        } catch (error) {
          return actionResultToMcp(
            err({
              transport: "subprocess",
              step: 0,
              action: "compute_capture.copy_reference",
              reason: errorMessage(error),
              suggestion:
                "inspect the clipboard command or retry with saveReference only",
              minimum_capability: "compute.capture.copy-reference",
              exit_code: exitCodeFor("service_unavailable"),
            }),
            def,
          );
        }
      }
      return actionResultToMcp(
        {
          ...result,
          data: {
            ...result.data,
            reference: {
              ...reference,
              ...(input.copyReference === true
                ? { clipboard: { ok: true } }
                : {}),
            },
          },
        },
        def,
      );
    },
  },
  computeToolDef("snapshot"),
  computeToolDef("find"),
  computeToolDef("click"),
  computeToolDef("type"),
  computeToolDef("press"),
  computeToolDef("scroll"),
  computeToolDef("launch"),
  computeToolDef("screenshot"),
  computeToolDef("attach"),
  {
    ...computeToolDef("eval"),
    transform: (input) => ({
      ...input,
      ...(typeof input.js === "string" ? { script: input.js } : {}),
    }),
  },
  computeToolDef("wait"),
  computeToolDef("observe"),
  computeToolDef("assert"),
];

export const COMPUTER_USE_PROMPTS: McpPrompt[] = [
  {
    name: "computer-use",
    description: "Operating guidance for controlling a real desktop",
    text: [
      "You are operating a real desktop through Uni-CLI.",
      "Start with compact accessibility snapshots and use the returned refs for actions.",
      "Use screenshots when accessibility data is empty or the UI is canvas-rendered.",
      "Use capture to package snapshot refs, screenshot evidence, image metadata, and app-shot references for handoff.",
      "Always re-snapshot after actions that may have changed the UI.",
      "Prefer background actions. Set focus only when the target app needs keyboard focus.",
      "Attach CDP to Electron apps when desktop accessibility misses renderer content.",
    ].join("\n"),
  },
];

export const COMPUTER_USE_TOOLS: McpTool[] = DEFINITIONS.map((def) => ({
  name: `computer-use.${def.suffix}`,
  description: def.description,
  inputSchema: def.inputSchema,
  annotations: {
    readOnlyHint: def.readOnly ?? false,
    destructiveHint: false,
    idempotentHint: def.readOnly ?? false,
  },
  handler: async (args) => {
    if (def.handler) return def.handler(args, def);
    const rawParams = def.transform ? def.transform(args) : args;
    const { params, overlay } = splitOverlayParams(rawParams);
    const overlayProvider =
      overlay === true ? createPlatformComputeOverlayProvider() : undefined;
    try {
      const execution = await executeComputeAction(
        getBus(),
        {
          kind: def.kind,
          params,
        },
        {
          tool: `computer-use.${def.suffix}`,
          ...(overlayProvider ? { overlayProvider } : {}),
          ...(overlayProvider ? { postActionCapture: true } : {}),
        },
      );
      return actionResultToMcp(
        execution.result,
        def,
        params,
        execution.evidence,
      );
    } finally {
      await overlayProvider?.close?.();
    }
  },
}));

function computeToolDef(command: string): ToolDef {
  const contract = getComputeCommandContract(command);
  if (!contract) {
    throw new Error(`missing compute command contract for ${command}`);
  }
  return {
    suffix: contract.mcpSuffix,
    description: contract.description,
    kind: contract.kind,
    inputSchema: buildComputeInputSchema(contract.args),
    readOnly: contract.readOnly,
  };
}

function actionResultToMcp(
  result: ActionResult<unknown>,
  def: ToolDef,
  params: Params = {},
  evidence?: ComputeActionExecution["evidence"],
): McpToolResult {
  const data = result.ok ? result.data : result.error;
  const transport = result.ok
    ? readResultTransport(result.data)
    : result.error.transport;
  const generatedEvidence = buildComputeActionVisualEvidence({
    tool: `computer-use.${def.suffix}`,
    action: def.kind,
    params,
    ok: result.ok,
    ...(transport ? { transport } : {}),
  });
  const visualTimeline =
    readResultVisualTimeline(data) ??
    evidence?.visual_timeline ??
    generatedEvidence.visual_timeline;
  const visualAction =
    readResultVisualAction(data) ??
    evidence?.visual_action ??
    generatedEvidence.visual_action;
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: { type: "json", data },
    _meta: {
      evidence: {
        evidence_type: "computer-use-action",
        tool: `computer-use.${def.suffix}`,
        action: def.kind,
        ok: result.ok,
        visual_timeline: visualTimeline,
        visual_action: visualAction,
        ...(result.ok
          ? {}
          : {
              transport: result.error.transport,
              minimum_capability: result.error.minimum_capability,
              retryable: result.error.retryable,
              exit_code: result.error.exit_code,
            }),
      },
    },
    ...(result.ok ? {} : { isError: true }),
  };
}

function readResultTransport(data: unknown): string | undefined {
  if (!isRecord(data) || typeof data.transport !== "string") return undefined;
  return data.transport;
}

function readResultVisualTimeline(data: unknown): unknown {
  if (!isRecord(data) || !isRecord(data.visual_timeline)) return undefined;
  return data.visual_timeline;
}

function readResultVisualAction(data: unknown): unknown {
  if (!isRecord(data) || !isRecord(data.visual_action)) return undefined;
  return data.visual_action;
}

function splitOverlayParams(params: Params): {
  params: Params;
  overlay: boolean;
} {
  const { overlay, ...rest } = params;
  return {
    params: rest,
    overlay: overlay === true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCaptureFormat(
  value: unknown,
):
  | { ok: true; value: "compact" | "tree" | "json" }
  | { ok: false; value: string } {
  if (value === undefined) return { ok: true, value: "compact" };
  if (value === "compact" || value === "tree" || value === "json") {
    return { ok: true, value };
  }
  return { ok: false, value: String(value) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
