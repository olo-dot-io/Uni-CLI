import { getBus } from "../../transport/bus.js";
import { tryCascade } from "../../transport/cascade.js";
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

type Params = Record<string, unknown>;

interface ToolDef {
  suffix: string;
  description: string;
  kind: string;
  inputSchema: McpTool["inputSchema"];
  readOnly?: boolean;
  transform?: (input: Params) => Params;
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
  handler: async (args) =>
    actionResultToMcp(
      await tryCascade(getBus(), {
        kind: def.kind,
        params: def.transform ? def.transform(args) : args,
      }),
      def,
    ),
}));

function actionResultToMcp(
  result: ActionResult<unknown>,
  def: ToolDef,
): McpToolResult {
  const data = result.ok ? result.data : result.error;
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: { type: "json", data },
    _meta: {
      evidence: {
        evidence_type: "computer-use-action",
        tool: `computer-use.${def.suffix}`,
        action: def.kind,
        ok: result.ok,
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
