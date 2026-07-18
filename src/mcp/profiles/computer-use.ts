/**
 * @owner       src::mcp::profiles::computer-use
 * @does        Project compute contracts plus direct browser control into cancellable, permission-enforced MCP computer-use tools and visual evidence.
 * @needs       compute authorization/capture/action modules, transport bus, direct browser-control profile, MCP tool contracts
 * @feeds       computer-use MCP profile
 * @breaks      Tool handlers must never create overlays, transports, files, clipboard writes, desktop actions, or browser targets before authorization.
 * @invariants  Every tool is authorized from canonical pre-transform arguments; request AbortSignal reaches the final transport and capture side effects; browser preparation, snapshot refs, target ownership, and foreground presence remain explicit.
 * @side-effects Controls local apps and browsers and may persist explicitly requested capture references.
 * @perf        One permission evaluation plus one selected compute cascade per ordinary call; direct browser tools retain their own bounded command budgets.
 * @concurrency MCP request signals isolate cancellation; the transport bus, ref store, and Browser Runtime Broker retain their documented scopes.
 * @test        tests/unit/mcp/tools.test.ts, tests/unit/mcp-server.test.ts, tests/unit/mcp/browser-control.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

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
import { authorizeComputeOperation } from "../../compute/permission.js";
import { buildComputeActionVisualEvidence } from "../../compute/visual-timeline.js";
import {
  buildComputeInputSchema,
  getComputeCommandContract,
} from "../../compute/contracts.js";
import { err, exitCodeFor } from "../../core/envelope.js";
import type { ActionResult } from "../../transport/types.js";
import type { McpToolResult } from "../dispatch.js";
import type { McpPrompt, McpTool, McpToolExecutionContext } from "../tools.js";

type Params = Record<string, unknown>;

interface ToolDef {
  command: string;
  suffix: string;
  description: string;
  kind: string;
  inputSchema: McpTool["inputSchema"];
  readOnly?: boolean;
  transform?: (input: Params) => Params;
  handler?: (
    input: Params,
    def: ToolDef,
    context?: McpToolExecutionContext,
  ) => Promise<McpToolResult>;
}

const DEFINITIONS: ToolDef[] = [
  computeToolDef("apps"),
  computeToolDef("windows"),
  {
    ...computeToolDef("capture"),
    handler: async (input, def, context) => {
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
      const result = await captureComputeContext(
        getBus(),
        {
          ...(typeof input.app === "string" ? { app: input.app } : {}),
          ...(typeof input.include === "string"
            ? { include: input.include }
            : {}),
          format: format.value,
          maxDepth:
            typeof input.maxDepth === "number" &&
            Number.isFinite(input.maxDepth)
              ? input.maxDepth
              : 64,
          ...(typeof input.screenshotPath === "string"
            ? { screenshotPath: input.screenshotPath }
            : {}),
        },
        context?.signal ? { signal: context.signal } : {},
      );
      const shouldSaveReference =
        input.saveReference === true || input.copyReference === true;
      if (!result.ok || !shouldSaveReference) {
        return actionResultToMcp(result, def);
      }
      context?.signal?.throwIfAborted();
      const referenceRoot =
        typeof input.referenceRoot === "string" && input.referenceRoot
          ? input.referenceRoot
          : undefined;
      const reference = await saveComputeCaptureReference(result.data, {
        ...(referenceRoot ? { rootDir: referenceRoot } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      context?.signal?.throwIfAborted();
      if (input.copyReference === true) {
        try {
          await copyReferenceMarkupToClipboard(
            reference.markup,
            context?.signal ? { signal: context.signal } : {},
          );
        } catch (error) {
          context?.signal?.throwIfAborted();
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
      "For owned work, call browser_prepare: Chrome creates an inactive owned tab, while managed and remote targets follow their configured policies.",
      "For an existing Chrome page, call browser_tabs and pass its explicit tab_id; browser_search scans bounded open-page/frame text and optional history without focus or debugger attachment.",
      "Call browser_state before ref-based browser_click/browser_type and reuse only refs from that snapshot; navigation or a newer snapshot invalidates older refs. Browser click also accepts one explicit viewport point for canvas-style targets.",
      "Browser state traverses open shadow roots and same-origin frames; cross-origin/OOPIF DOM refs are unsupported and reported rather than guessed.",
      "Use browser_screenshot, browser_press, browser_scroll, browser_dialogs/browser_dialog, and browser_downloads for exact target supervision.",
      "Page edge presence and the virtual cursor require --browser-provider chrome --browser-visibility foreground and an explicit tab_id.",
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
  execution: {
    taskSupport: def.readOnly === true ? "optional" : "required",
  },
  handler: async (args, context) => {
    context?.signal?.throwIfAborted();
    const authorization = await authorizeComputeOperation(def.command, args);
    if (!authorization.ok) {
      return actionResultToMcp(authorization.result, def, args);
    }
    context?.signal?.throwIfAborted();
    if (def.handler) return def.handler(args, def, context);
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
          ...(context?.signal ? { signal: context.signal } : {}),
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
    command: contract.command,
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
  const rawData = result.ok ? result.data : result.error;
  const image =
    result.ok && (def.command === "screenshot" || def.command === "capture")
      ? readImagePayload(rawData)
      : undefined;
  const data = image ? withoutImageBytes(rawData, image.mimeType) : rawData;
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
    content: [
      ...(image
        ? [
            {
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            },
          ]
        : []),
      { type: "text", text: JSON.stringify(data, null, 2) },
    ],
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

interface McpImagePayload {
  data: string;
  mimeType: string;
}

function readImagePayload(data: unknown): McpImagePayload | undefined {
  const candidate = captureScreenshotData(data) ?? data;
  if (Buffer.isBuffer(candidate)) {
    const mimeType = inferImageMime(candidate);
    return mimeType
      ? { data: candidate.toString("base64"), mimeType }
      : undefined;
  }
  if (!isRecord(candidate) || typeof candidate.base64 !== "string") {
    return undefined;
  }
  const bytes = Buffer.from(candidate.base64, "base64");
  const declaredMime =
    typeof candidate.mime === "string"
      ? candidate.mime
      : isRecord(candidate.image) && typeof candidate.image.mime === "string"
        ? candidate.image.mime
        : undefined;
  const mimeType =
    declaredMime?.startsWith("image/") === true
      ? declaredMime
      : inferImageMime(bytes);
  if (!mimeType || bytes.length === 0) return undefined;
  return { data: candidate.base64, mimeType };
}

function captureScreenshotData(data: unknown): unknown {
  if (!isRecord(data) || !isRecord(data.screenshot)) return undefined;
  return data.screenshot.ok === true ? data.screenshot.data : undefined;
}

function withoutImageBytes(data: unknown, mimeType: string): unknown {
  if (Buffer.isBuffer(data)) {
    return { bytes: data.length, mime: mimeType };
  }
  if (Array.isArray(data)) {
    return data.map((entry) => withoutImageBytes(entry, mimeType));
  }
  if (!isRecord(data)) return data;
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => key !== "base64")
      .map(([key, value]) => [key, withoutImageBytes(value, mimeType)]),
  );
}

function inferImageMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.subarray(1, 4).toString("ascii") === "PNG"
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
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
