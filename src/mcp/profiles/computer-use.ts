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
import { err, exitCodeFor } from "../../core/envelope.js";
import type { ActionResult } from "../../transport/types.js";
import type { McpToolResult } from "../dispatch.js";
import type { McpPrompt, McpTool } from "../tools.js";

const REF = {
  type: "string",
  description:
    'Element ref returned by computer-use.snapshot or computer-use.find, e.g. "@e7"',
};

const APP = {
  type: "string",
  description: 'App name, bundle id, or process name, e.g. "Slack"',
};

const FOCUS = { type: "boolean", default: false };
const OVERLAY = {
  type: "boolean",
  default: false,
  description: "Render the system-level virtual cursor HUD for this action.",
};

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
  {
    suffix: "apps",
    description:
      "List currently running applications visible to the native computer-control layer.",
    kind: "compute_apps",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
  },
  {
    suffix: "windows",
    description: "List top-level windows, optionally scoped to an app.",
    kind: "compute_windows",
    inputSchema: { type: "object", properties: { app: APP } },
    readOnly: true,
  },
  {
    suffix: "capture",
    description:
      "Capture a reusable app context packet with snapshot refs and/or screenshot evidence.",
    kind: "compute_capture",
    inputSchema: {
      type: "object",
      properties: {
        app: APP,
        include: { type: "string", default: "snapshot,screenshot" },
        format: {
          type: "string",
          enum: ["compact", "tree", "json"],
          default: "compact",
        },
        maxDepth: { type: "integer", default: 64 },
        screenshotPath: { type: "string" },
        saveReference: { type: "boolean", default: false },
        copyReference: { type: "boolean", default: false },
        referenceRoot: { type: "string" },
      },
    },
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
  {
    suffix: "snapshot",
    description:
      "Capture a compact accessibility snapshot. Use returned @e refs for later actions.",
    kind: "compute_snapshot",
    inputSchema: {
      type: "object",
      properties: {
        app: APP,
        format: {
          type: "string",
          enum: ["compact", "tree", "json"],
          default: "compact",
        },
        interactiveOnly: { type: "boolean", default: false },
        maxDepth: { type: "integer", default: 64 },
      },
    },
    readOnly: true,
  },
  {
    suffix: "find",
    description:
      "Find elements from the latest snapshot by role, name, or visible/current text value.",
    kind: "compute_find",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: [
            "button",
            "input",
            "textarea",
            "text",
            "menuitem",
            "checkbox",
            "radio",
            "link",
            "image",
            "window",
            "group",
            "list",
            "listitem",
            "tab",
            "tree",
            "treeitem",
            "slider",
            "combobox",
            "spinbutton",
          ],
        },
        name: { type: "string" },
        text: { type: "string" },
        app: APP,
        first: { type: "boolean", default: false },
      },
      required: ["role"],
    },
    readOnly: true,
  },
  {
    suffix: "click",
    description: "Click an element by ref.",
    kind: "compute_click",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: { type: "boolean", default: false },
        focus: FOCUS,
        overlay: OVERLAY,
      },
      required: ["ref"],
    },
  },
  {
    suffix: "type",
    description: "Type text into an element ref.",
    kind: "compute_type",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        text: { type: "string" },
        clear: { type: "boolean", default: false },
        focus: FOCUS,
        overlay: OVERLAY,
      },
      required: ["ref", "text"],
    },
  },
  {
    suffix: "press",
    description: 'Press a keyboard combo, e.g. "cmd+s" or "ctrl+shift+p".',
    kind: "compute_press",
    inputSchema: {
      type: "object",
      properties: {
        combo: { type: "string" },
        app: APP,
        focus: FOCUS,
      },
      required: ["combo"],
    },
  },
  {
    suffix: "scroll",
    description: "Scroll an element or the active view.",
    kind: "compute_scroll",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          default: "down",
        },
        amount: { type: "integer", default: 300 },
        focus: FOCUS,
        overlay: OVERLAY,
      },
    },
  },
  {
    suffix: "launch",
    description: "Launch an app by name, bundle id, process name, or path.",
    kind: "compute_launch",
    inputSchema: {
      type: "object",
      properties: {
        app: APP,
        debugPort: { type: "integer" },
      },
      required: ["app"],
    },
  },
  {
    suffix: "screenshot",
    description:
      "Capture a pixel screenshot. Prefer snapshot unless accessibility data is unavailable.",
    kind: "compute_screenshot",
    inputSchema: {
      type: "object",
      properties: {
        app: APP,
        path: { type: "string", description: "Optional output path" },
      },
    },
    readOnly: true,
  },
  {
    suffix: "attach",
    description: "Attach to an Electron app or explicit CDP port.",
    kind: "compute_cdp_attach",
    inputSchema: {
      type: "object",
      properties: {
        app: APP,
        port: { type: "integer" },
        confirmRelaunch: { type: "boolean", default: false },
      },
    },
  },
  {
    suffix: "evaluate",
    description: "Run JavaScript in the attached CDP renderer.",
    kind: "compute_evaluate",
    inputSchema: {
      type: "object",
      properties: {
        js: { type: "string" },
        targetId: { type: "string" },
      },
      required: ["js"],
    },
    transform: (input) => ({
      ...input,
      ...(typeof input.js === "string" ? { script: input.js } : {}),
    }),
  },
  {
    suffix: "wait",
    description: "Wait for a ref, text, or state condition.",
    kind: "compute_wait",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        text: { type: "string" },
        app: APP,
        state: { type: "string", enum: ["appear", "disappear", "focused"] },
        timeoutMs: { type: "integer", default: 10_000 },
      },
    },
    readOnly: true,
  },
  {
    suffix: "observe",
    description:
      "Rank candidate refs for a natural-language goal from the latest snapshot.",
    kind: "compute_observe",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        app: APP,
        topK: { type: "integer", default: 5 },
      },
      required: ["goal"],
    },
    readOnly: true,
  },
  {
    suffix: "assert",
    description: "Assert a UI condition by ref, text, or state.",
    kind: "compute_assert",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        text: { type: "string" },
        state: {
          type: "string",
          enum: ["enabled", "focused", "checked", "visible"],
        },
      },
    },
    readOnly: true,
  },
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
