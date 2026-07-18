/**
 * @owner   src/compute/contracts.ts
 * @does    Define the shared compute command and ref-provenance contract projected into CLI discovery, schema, and MCP.
 * @needs   none
 * @feeds   src/discovery/core-catalog.ts, src/mcp/profiles/computer-use.ts, src/compute/permission.ts, src/transport/cascade.ts
 * @breaks  Drift here makes agents compile invalid computer-use calls or route refs to the wrong provider.
 * @invariants Ref-consuming commands declare accepted namespaces in the same description used by describe/schema/MCP; readOnly is the single source of compute mutation truth.
 * @side-effects none
 * @perf    Static data and O(argument count) schema projection.
 * @concurrency immutable constants.
 * @test    tests/unit/command-contract.test.ts, tests/unit/mcp/tools.test.ts, tests/unit/compute-cascade.test.ts
 * @stability provisional
 * @since   0.225.1
 */

export type ComputeArgType = "str" | "int" | "float" | "bool";

export interface ComputeCommandArg {
  readonly name: string;
  readonly type?: ComputeArgType;
  readonly default?: unknown;
  readonly required?: boolean;
  readonly positional?: boolean;
  readonly choices?: readonly string[];
  readonly description?: string;
}

export interface ComputeCommandContract {
  readonly command: string;
  readonly mcpSuffix: string;
  readonly kind: string;
  readonly description: string;
  readonly args: readonly ComputeCommandArg[];
  readonly readOnly?: boolean;
  readonly channels?: Record<string, string>;
}

export interface ComputeJsonSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  enum?: string[];
}

export interface ComputeJsonSchemaObject {
  type: "object";
  properties: Record<string, ComputeJsonSchemaProperty>;
  required?: string[];
  additionalProperties?: false;
}

export const COMPUTE_REF_ACCEPTED_NAMESPACES = [
  "@e* short aliases allocated within one Uni-CLI snapshot scope; ambiguous live scopes require an exact target hint or stable ref",
  "desktop-ax:* stable refs from the Uni-CLI macOS AX transport",
  "desktop-uia:* stable refs from the Uni-CLI Windows UIA transport",
  "desktop-atspi:* stable refs from the Uni-CLI Linux AT-SPI transport",
  "cdp-browser:* or cdp:* stable refs allocated by Uni-CLI compute CDP snapshots",
] as const;

export const COMPUTE_FOREIGN_REF_NAMESPACES = [
  "olo:accessibility:* refs are OLo-owned and must be executed by OLo's accessibility provider",
  "browser-scoped DOM refs must be executed by the browser provider that created them",
] as const;

export const COMPUTE_REF_DESCRIPTION = [
  "Uni-CLI compute element ref.",
  `Accepts ${COMPUTE_REF_ACCEPTED_NAMESPACES.join("; ")}.`,
  `Does not accept ${COMPUTE_FOREIGN_REF_NAMESPACES.join("; ")}.`,
].join(" ");

const APP_ARG: ComputeCommandArg = {
  name: "app",
  type: "str",
  description:
    'Target app identity; native providers accept a visible app/window name and providers with bundle/process metadata accept those exact identities, e.g. "Slack"',
};

const WINDOW_ID_ARG: ComputeCommandArg = {
  name: "windowId",
  type: "str",
  description:
    "Exact native window id reported by compute windows or a target-bound ref.",
};

const FOCUS_ARG: ComputeCommandArg = {
  name: "focus",
  type: "bool",
  default: false,
  description: "Focus the target app before the action.",
};

const BACKGROUND_ARG: ComputeCommandArg = {
  name: "background",
  type: "bool",
  default: false,
  description: "Explicitly keep the target app in the background.",
};

const OVERLAY_ARG: ComputeCommandArg = {
  name: "overlay",
  type: "bool",
  default: false,
  description: "Render the system-level virtual cursor HUD for this action.",
};

const REF_ARG: ComputeCommandArg = {
  name: "ref",
  type: "str",
  required: true,
  positional: true,
  description: COMPUTE_REF_DESCRIPTION,
};

const SNAPSHOT_FORMAT_ARG: ComputeCommandArg = {
  name: "format",
  type: "str",
  default: "compact",
  choices: ["compact", "tree", "json"],
  description: "Snapshot encoding for accessibility refs",
};

const MAX_DEPTH_ARG: ComputeCommandArg = {
  name: "maxDepth",
  type: "int",
  default: 64,
  description: "Maximum accessibility tree depth",
};

const ROLE_CHOICES = [
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
] as const;

export const COMPUTE_COMMAND_CONTRACTS: readonly ComputeCommandContract[] = [
  {
    command: "apps",
    mcpSuffix: "apps",
    kind: "compute_apps",
    readOnly: true,
    args: [],
    description:
      "List currently running applications visible to the native computer-control layer.",
  },
  {
    command: "windows",
    mcpSuffix: "windows",
    kind: "compute_windows",
    readOnly: true,
    args: [APP_ARG],
    description: "List top-level windows, optionally scoped to an app.",
  },
  {
    command: "snapshot",
    mcpSuffix: "snapshot",
    kind: "compute_snapshot",
    readOnly: true,
    args: [
      APP_ARG,
      WINDOW_ID_ARG,
      SNAPSHOT_FORMAT_ARG,
      {
        name: "interactiveOnly",
        type: "bool",
        default: false,
        description: "Only include interactive elements",
      },
      MAX_DEPTH_ARG,
    ],
    description:
      "Capture a compact accessibility snapshot with Uni-CLI-owned refs for later compute actions.",
  },
  {
    command: "capture",
    mcpSuffix: "capture",
    kind: "compute_capture",
    args: [
      APP_ARG,
      WINDOW_ID_ARG,
      SNAPSHOT_FORMAT_ARG,
      {
        name: "include",
        type: "str",
        default: "snapshot,screenshot",
        description: "Comma-separated capture parts: snapshot,screenshot",
      },
      MAX_DEPTH_ARG,
      {
        name: "screenshotPath",
        type: "str",
        description: "Optional screenshot output path",
      },
      {
        name: "saveReference",
        type: "bool",
        default: false,
        description: "Persist app-shot handoff artifacts",
      },
      {
        name: "copyReference",
        type: "bool",
        default: false,
        description: "Persist and copy app-shot handoff markup",
      },
      {
        name: "referenceRoot",
        type: "str",
        description: "Directory for saved app-shot artifacts",
      },
    ],
    channels: {
      shell:
        "unicli compute capture [--app <name>] [--include snapshot,screenshot] [--format compact] [--copy-reference]",
      args_file: "unicli compute capture --args-file <path.json>",
      stdin: "echo '{...}' | unicli compute capture",
    },
    description:
      "Capture local computer-use context by combining accessibility refs, app state, screenshot evidence, image metadata, app-shot reference artifacts, clipboard handoff markup, and replayable capture trajectory.",
  },
  {
    command: "find",
    mcpSuffix: "find",
    kind: "compute_find",
    readOnly: true,
    args: [
      {
        name: "role",
        type: "str",
        required: true,
        choices: ROLE_CHOICES,
        description:
          "Element role to match from the latest Uni-CLI compute ref store",
      },
      {
        name: "name",
        type: "str",
        description: "Substring match against the accessible name",
      },
      {
        name: "text",
        type: "str",
        description: "Match visible or current text value",
      },
      APP_ARG,
      WINDOW_ID_ARG,
      {
        name: "first",
        type: "bool",
        default: false,
        description: "Return the first unambiguous match",
      },
    ],
    description:
      "Find elements from the latest Uni-CLI compute snapshot by role, name, or visible/current text value.",
  },
  {
    command: "click",
    mcpSuffix: "click",
    kind: "compute_click",
    args: [REF_ARG, BACKGROUND_ARG, FOCUS_ARG, OVERLAY_ARG],
    description: "Click a Uni-CLI compute element by ref.",
  },
  {
    command: "type",
    mcpSuffix: "type",
    kind: "compute_type",
    args: [
      REF_ARG,
      {
        name: "text",
        type: "str",
        required: true,
        positional: true,
        description: "Text to type or set into the target element",
      },
      {
        name: "clear",
        type: "bool",
        default: false,
        description: "Clear the field before entering text when supported",
      },
      FOCUS_ARG,
      OVERLAY_ARG,
    ],
    description: "Type text into a Uni-CLI compute element ref.",
  },
  {
    command: "press",
    mcpSuffix: "press",
    kind: "compute_press",
    args: [
      {
        name: "combo",
        type: "str",
        required: true,
        positional: true,
        description: 'Keyboard combo, e.g. "cmd+s" or "ctrl+shift+p"',
      },
      APP_ARG,
      FOCUS_ARG,
    ],
    description: 'Press a keyboard combo, e.g. "cmd+s" or "ctrl+shift+p".',
  },
  {
    command: "scroll",
    mcpSuffix: "scroll",
    kind: "compute_scroll",
    args: [
      REF_ARG,
      {
        name: "direction",
        type: "str",
        choices: ["up", "down", "left", "right"],
        default: "down",
        description: "Scroll direction",
      },
      {
        name: "amount",
        type: "int",
        default: 300,
        description: "Pixels or transport-native scroll amount",
      },
      FOCUS_ARG,
      OVERLAY_ARG,
    ],
    description: "Scroll a Uni-CLI compute element or active view.",
  },
  {
    command: "launch",
    mcpSuffix: "launch",
    kind: "compute_launch",
    args: [
      {
        name: "app",
        type: "str",
        required: true,
        positional: true,
        description: "App name, bundle id, process name, or path",
      },
      {
        name: "debugPort",
        type: "int",
        description: "Electron CDP debug port",
      },
    ],
    description: "Launch an app by name, bundle id, process name, or path.",
  },
  {
    command: "screenshot",
    mcpSuffix: "screenshot",
    kind: "compute_screenshot",
    readOnly: true,
    args: [
      {
        name: "path",
        type: "str",
        positional: true,
        description: "Optional output path",
      },
      APP_ARG,
      WINDOW_ID_ARG,
    ],
    description:
      "Capture a pixel screenshot. Prefer snapshot unless accessibility data is unavailable.",
  },
  {
    command: "attach",
    mcpSuffix: "attach",
    kind: "compute_cdp_attach",
    args: [
      APP_ARG,
      {
        name: "port",
        type: "int",
        description: "CDP port",
      },
      {
        name: "targetId",
        type: "str",
        description: "Exact CDP renderer target id",
      },
      {
        name: "confirmRelaunch",
        type: "bool",
        default: false,
        description: "Allow relaunching apps that may lose session state",
      },
    ],
    description: "Attach to an exact Electron/CDP renderer target.",
  },
  {
    command: "eval",
    mcpSuffix: "evaluate",
    kind: "compute_evaluate",
    args: [
      {
        name: "js",
        type: "str",
        required: true,
        positional: true,
        description: "JavaScript to evaluate in the attached CDP renderer",
      },
      {
        name: "targetId",
        type: "str",
        description: "Optional CDP target id",
      },
    ],
    description: "Run JavaScript in the attached CDP renderer.",
  },
  {
    command: "wait",
    mcpSuffix: "wait",
    kind: "compute_wait",
    readOnly: true,
    args: [
      {
        ...REF_ARG,
        required: false,
        positional: false,
      },
      {
        name: "text",
        type: "str",
        description: "Text to wait for",
      },
      APP_ARG,
      WINDOW_ID_ARG,
      {
        name: "state",
        type: "str",
        choices: ["appear", "disappear", "focused", "enabled", "checked"],
        description: "State condition to wait for",
      },
      {
        name: "timeoutMs",
        type: "int",
        default: 10_000,
        description: "Timeout in milliseconds (1-300000)",
      },
    ],
    description:
      "Wait for a ref, text, or state condition on one explicit app, live Uni-CLI ref, or attached CDP target.",
  },
  {
    command: "observe",
    mcpSuffix: "observe",
    kind: "compute_observe",
    readOnly: true,
    args: [
      {
        name: "goal",
        type: "str",
        required: true,
        positional: true,
        description: "Natural-language goal used to rank candidate refs",
      },
      APP_ARG,
      {
        name: "topK",
        type: "int",
        default: 5,
        description: "Maximum candidate refs to return",
      },
    ],
    description:
      "Rank candidate refs for a natural-language goal from the latest Uni-CLI compute snapshot.",
  },
  {
    command: "assert",
    mcpSuffix: "assert",
    kind: "compute_assert",
    readOnly: true,
    args: [
      {
        ...REF_ARG,
        required: false,
        positional: false,
      },
      {
        name: "text",
        type: "str",
        description: "Expected text",
      },
      {
        name: "state",
        type: "str",
        choices: ["enabled", "focused", "checked", "visible"],
        description: "State to assert",
      },
    ],
    description: "Assert a UI condition by ref, text, or state.",
  },
] as const;

export function getComputeCommandContract(
  command: string,
): ComputeCommandContract | undefined {
  return COMPUTE_COMMAND_CONTRACTS.find(
    (candidate) => candidate.command === command,
  );
}

export function getComputeCommandContractByMcpSuffix(
  suffix: string,
): ComputeCommandContract | undefined {
  return COMPUTE_COMMAND_CONTRACTS.find(
    (candidate) => candidate.mcpSuffix === suffix,
  );
}

export function computeCommandCanMutate(kind: string): boolean {
  const contract = COMPUTE_COMMAND_CONTRACTS.find(
    (candidate) => candidate.kind === kind,
  );
  return contract !== undefined && contract.readOnly !== true;
}

export function buildComputeInputSchema(
  args: readonly ComputeCommandArg[],
): ComputeJsonSchemaObject {
  const properties: Record<string, ComputeJsonSchemaProperty> = {};
  const required: string[] = [];
  for (const arg of args) {
    const property: ComputeJsonSchemaProperty = {
      type: jsonTypeForComputeArg(arg.type),
    };
    if (arg.description !== undefined) property.description = arg.description;
    if (arg.default !== undefined) property.default = arg.default;
    if (arg.choices !== undefined && arg.choices.length > 0) {
      property.enum = [...arg.choices];
    }
    properties[arg.name] = property;
    if (arg.required === true) required.push(arg.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function isComputeStableRefNamespace(ref: string): boolean {
  return (
    ref.startsWith("desktop-ax:") ||
    ref.startsWith("desktop-uia:") ||
    ref.startsWith("desktop-atspi:") ||
    ref.startsWith("cdp-browser:") ||
    ref.startsWith("cdp:")
  );
}

export function readForeignComputeRefOwner(ref: string): string | undefined {
  if (ref.startsWith("olo:accessibility:")) return "olo.accessibility";
  if (ref.startsWith("browser:") || ref.startsWith("dom:")) {
    return "browser";
  }
  if (ref.includes(":") && !isComputeStableRefNamespace(ref)) return "unknown";
  return undefined;
}

function jsonTypeForComputeArg(type: ComputeArgType | undefined): string {
  if (type === "int") return "integer";
  if (type === "float") return "number";
  if (type === "bool") return "boolean";
  return "string";
}
