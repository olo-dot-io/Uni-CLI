/**
 * @owner   src/compute/contracts.ts
 * @does    Define the shared compute command and ref-provenance contract projected into CLI discovery, schema, and MCP.
 * @needs   none
 * @feeds   src/discovery/core-catalog.ts, src/mcp/profiles/computer-use.ts, src/compute/permission.ts, src/transport/compute-dispatch.ts
 * @breaks  Drift here makes agents compile invalid computer-use calls or route refs to the wrong provider.
 * @invariants Ref-consuming commands declare accepted namespaces in the same description used by describe/schema/MCP; readOnly is the single source of compute mutation truth.
 * @side-effects none
 * @perf    Static data and O(argument count) schema projection.
 * @concurrency immutable constants.
 * @test    tests/unit/command-contract.test.ts, tests/unit/mcp/tools.test.ts, tests/unit/compute-dispatch.test.ts
 * @stability provisional
 * @since   0.225.1
 */

import type { CommandOperatorProfile } from "../core/operator-model.js";
import {
  compileArgumentSchema,
  type CompiledArgumentSchema,
} from "../core/argument-schema.js";

export type ComputeArgType =
  | "str"
  | "str[]"
  | "int"
  | "float"
  | "nullable-float"
  | "str-or-int"
  | "bool";

export interface ComputeCommandArg {
  readonly name: string;
  readonly type?: ComputeArgType;
  readonly default?: unknown;
  readonly required?: boolean;
  readonly positional?: boolean;
  readonly choices?: readonly string[];
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

export interface ComputeCommandContract {
  readonly command: string;
  readonly mcpSuffix: string;
  readonly kind: string;
  readonly executionOperator:
    | "native-cli"
    | "browser-semantic"
    | "desktop-accessibility"
    | "visual-observation"
    | "visual-coordinate"
    | "local-runtime";
  readonly executionProfile?: Partial<
    Omit<
      CommandOperatorProfile,
      | "operator"
      | "selection_reason"
      | "operator_source"
      | "operator_confidence"
    >
  >;
  readonly description: string;
  readonly args: readonly ComputeCommandArg[];
  readonly readOnly?: boolean;
  readonly channels?: Record<string, string>;
}

export interface ComputeJsonSchemaProperty {
  type: string | string[];
  items?: { type: string };
  description?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
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
  type: "str-or-int",
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

const VIA_ARG: ComputeCommandArg = {
  name: "via",
  type: "str",
  choices: ["native", "browser", "process", "driver", "visual"],
  description:
    "Select one execution route. Driver and visual are explicit desktop-coordinate routes and are never selected after another provider fails.",
};

const COORDINATE_VIA_ARG: ComputeCommandArg = {
  name: "via",
  type: "str",
  required: true,
  choices: ["driver", "visual"],
  description:
    "Select one desktop-coordinate provider. Driver calls the optional Cua Driver OS service; visual calls the configured visual backend.",
};

const DRIVER_VIA_ARG: ComputeCommandArg = {
  name: "via",
  type: "str",
  required: true,
  choices: ["driver"],
  description: "Select the portable Cua Driver desktop-coordinate provider.",
};

const VISUAL_OBSERVATION_ARG: ComputeCommandArg = {
  name: "observation",
  type: "str",
  required: true,
  minLength: 83,
  maxLength: 83,
  description:
    "Opaque, single-use visual-observation ref returned by a fresh compute screenshot from the same provider, scope, and session.",
};

const SESSION_ARG: ComputeCommandArg = {
  name: "session",
  type: "str",
  required: true,
  positional: true,
  description: "Stable, non-secret identity for this agent run.",
};

const CUA_SESSION_LIFECYCLE_PROFILE = {
  provider: "cua-driver",
  perception: "local-state",
  actuation: "protocol-call",
  target_scope: "local-runtime",
  verification: "local-result",
  interaction_impact: "background",
  coordinate_actuation: false,
} as const;

const CUA_SESSION_READ_PROFILE = {
  ...CUA_SESSION_LIFECYCLE_PROFILE,
  actuation: "none",
} as const;

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
    executionOperator: "desktop-accessibility",
    readOnly: true,
    args: [],
    description:
      "List currently running applications visible to the native computer-control layer.",
  },
  {
    command: "windows",
    mcpSuffix: "windows",
    kind: "compute_windows",
    executionOperator: "desktop-accessibility",
    readOnly: true,
    args: [APP_ARG],
    description: "List top-level windows, optionally scoped to an app.",
  },
  {
    command: "snapshot",
    mcpSuffix: "snapshot",
    kind: "compute_snapshot",
    executionOperator: "desktop-accessibility",
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
      VIA_ARG,
    ],
    description:
      "Capture a compact accessibility snapshot with Uni-CLI-owned refs for later compute actions.",
  },
  {
    command: "capture",
    mcpSuffix: "capture",
    kind: "compute_capture",
    executionOperator: "local-runtime",
    executionProfile: {
      provider: "compute-composite-plan",
      perception: "local-state",
      actuation: "local-function",
      target_scope: "local-runtime",
      verification: "local-result",
      interaction_impact: "background",
      coordinate_actuation: false,
    },
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
      VIA_ARG,
    ],
    channels: {
      shell:
        "unicli compute capture [--app <name>] [--include snapshot,screenshot] [--format compact] [--copy-reference]",
      args_file: "unicli compute capture --args-file <path.json>",
      stdin: "echo '{...}' | unicli compute capture",
    },
    description:
      "Run an explicit composite capture plan over requested accessibility, screenshot, app-state, artifact, and clipboard parts; every sub-operation retains its own provider and partial result.",
  },
  {
    command: "find",
    mcpSuffix: "find",
    kind: "compute_find",
    executionOperator: "local-runtime",
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
    executionOperator: "desktop-accessibility",
    args: [REF_ARG, BACKGROUND_ARG, FOCUS_ARG, OVERLAY_ARG, VIA_ARG],
    description: "Click a Uni-CLI compute element by ref.",
  },
  {
    command: "point-click",
    mcpSuffix: "point_click",
    kind: "compute_point_click",
    executionOperator: "visual-coordinate",
    args: [
      {
        name: "x",
        type: "float",
        required: true,
        positional: true,
        description:
          "Absolute desktop screenshot x coordinate from the selected provider's fresh pixels.",
      },
      {
        name: "y",
        type: "float",
        required: true,
        positional: true,
        description:
          "Absolute desktop screenshot y coordinate from the selected provider's fresh pixels.",
      },
      {
        name: "button",
        type: "str",
        choices: ["left", "right", "middle"],
        default: "left",
        description: "Mouse button.",
      },
      {
        name: "count",
        type: "int",
        default: 1,
        minimum: 1,
        maximum: 3,
        description: "Click count from 1 to 3.",
      },
      {
        ...SESSION_ARG,
        required: false,
        positional: false,
      },
      VISUAL_OBSERVATION_ARG,
      COORDINATE_VIA_ARG,
    ],
    description:
      "Click one absolute desktop point from fresh provider-owned pixel evidence. This coordinate operation never accepts or guesses an element ref.",
  },
  {
    command: "drag",
    mcpSuffix: "drag",
    kind: "compute_drag",
    executionOperator: "visual-coordinate",
    args: [
      {
        name: "fromX",
        type: "float",
        required: true,
        positional: true,
        description: "Absolute desktop start x coordinate.",
      },
      {
        name: "fromY",
        type: "float",
        required: true,
        positional: true,
        description: "Absolute desktop start y coordinate.",
      },
      {
        name: "toX",
        type: "float",
        required: true,
        positional: true,
        description: "Absolute desktop end x coordinate.",
      },
      {
        name: "toY",
        type: "float",
        required: true,
        positional: true,
        description: "Absolute desktop end y coordinate.",
      },
      {
        name: "button",
        type: "str",
        choices: ["left", "right", "middle"],
        default: "left",
        description: "Mouse button held during the drag.",
      },
      {
        name: "durationMs",
        type: "int",
        minimum: 0,
        maximum: 10_000,
        description: "Optional drag duration from 0 to 10000 milliseconds.",
      },
      {
        name: "modifier",
        type: "str[]",
        description: "Modifier keys held during the drag.",
      },
      {
        name: "steps",
        type: "int",
        minimum: 1,
        maximum: 200,
        description: "Optional interpolation step count from 1 to 200.",
      },
      {
        ...SESSION_ARG,
        required: false,
        positional: false,
      },
      VISUAL_OBSERVATION_ARG,
      COORDINATE_VIA_ARG,
    ],
    description:
      "Drag between two absolute desktop points through one explicitly selected coordinate provider.",
  },
  {
    command: "type",
    mcpSuffix: "type",
    kind: "compute_type",
    executionOperator: "desktop-accessibility",
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
      VIA_ARG,
    ],
    description: "Type text into a Uni-CLI compute element ref.",
  },
  {
    command: "text",
    mcpSuffix: "text",
    kind: "compute_text",
    executionOperator: "visual-coordinate",
    args: [
      {
        name: "text",
        type: "str",
        required: true,
        positional: true,
        description: "Literal text sent to the current foreground desktop app.",
      },
      {
        ...SESSION_ARG,
        required: false,
        positional: false,
      },
      COORDINATE_VIA_ARG,
    ],
    description:
      "Send text to the current foreground desktop app without claiming an element target. Use compute type for ref-owned semantic input.",
  },
  {
    command: "press",
    mcpSuffix: "press",
    kind: "compute_press",
    executionOperator: "desktop-accessibility",
    args: [
      {
        name: "combo",
        type: "str",
        required: true,
        positional: true,
        description: 'Keyboard combo, e.g. "cmd+s" or "ctrl+shift+p"',
      },
      {
        name: "modifiers",
        type: "str[]",
        description:
          "Optional modifier keys for a single press_key. Encode a multi-key hotkey in combo instead.",
      },
      {
        ...SESSION_ARG,
        required: false,
        positional: false,
      },
      APP_ARG,
      FOCUS_ARG,
      VIA_ARG,
    ],
    description: 'Press a keyboard combo, e.g. "cmd+s" or "ctrl+shift+p".',
  },
  {
    command: "scroll",
    mcpSuffix: "scroll",
    kind: "compute_scroll",
    executionOperator: "desktop-accessibility",
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
      VIA_ARG,
    ],
    description: "Scroll a Uni-CLI compute element or active view.",
  },
  {
    command: "point-scroll",
    mcpSuffix: "point_scroll",
    kind: "compute_point_scroll",
    executionOperator: "visual-coordinate",
    args: [
      {
        name: "x",
        type: "float",
        required: true,
        positional: true,
        description: "Absolute desktop x coordinate under the pointer.",
      },
      {
        name: "y",
        type: "float",
        required: true,
        positional: true,
        description: "Absolute desktop y coordinate under the pointer.",
      },
      {
        name: "direction",
        type: "str",
        choices: ["up", "down", "left", "right"],
        default: "down",
        description: "Scroll direction.",
      },
      {
        name: "amount",
        type: "int",
        default: 3,
        minimum: 1,
        maximum: 50,
        description: "Provider-native line or page count from 1 to 50.",
      },
      {
        name: "by",
        type: "str",
        choices: ["line", "page"],
        default: "line",
        description: "Scroll unit.",
      },
      {
        ...SESSION_ARG,
        required: false,
        positional: false,
      },
      VISUAL_OBSERVATION_ARG,
      DRIVER_VIA_ARG,
    ],
    description:
      "Scroll at one absolute desktop point through the explicitly selected Cua Driver provider.",
  },
  {
    command: "launch",
    mcpSuffix: "launch",
    kind: "compute_launch",
    executionOperator: "native-cli",
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
      VIA_ARG,
    ],
    description: "Launch an app by name, bundle id, process name, or path.",
  },
  {
    command: "screenshot",
    mcpSuffix: "screenshot",
    kind: "compute_screenshot",
    executionOperator: "visual-observation",
    args: [
      {
        name: "path",
        type: "str",
        positional: true,
        description: "Optional output path",
      },
      APP_ARG,
      WINDOW_ID_ARG,
      { ...SESSION_ARG, required: false, positional: false },
      VIA_ARG,
    ],
    description:
      "Capture pixels for tasks that require visual evidence; inline driver or visual captures return an opaque, short-lived, single-use observation ref for coordinate actions. Use snapshot for accessibility semantics.",
  },
  {
    command: "session-start",
    mcpSuffix: "session_start",
    kind: "compute_session_start",
    executionOperator: "local-runtime",
    executionProfile: CUA_SESSION_LIFECYCLE_PROFILE,
    args: [
      SESSION_ARG,
      {
        name: "captureScope",
        type: "str",
        choices: ["auto", "window", "desktop"],
        default: "auto",
        description:
          "desktop matches coordinate actions; auto starts window-scoped and requires explicit escalation, while window is strict.",
      },
      {
        name: "cursorThemeId",
        type: "str",
        description:
          "Optional initial agent-cursor theme applied before the cursor becomes visible.",
      },
      {
        name: "reducedMotion",
        type: "str",
        choices: ["auto", "on", "off"],
        default: "auto",
        description: "Initial cursor reduced-motion policy.",
      },
    ],
    description:
      "Declare a Cua Driver session and its immutable capture policy. The command itself explicitly selects the driver capability.",
  },
  {
    command: "session-state",
    mcpSuffix: "session_state",
    kind: "compute_session_state",
    executionOperator: "local-runtime",
    executionProfile: CUA_SESSION_READ_PROFILE,
    readOnly: true,
    args: [SESSION_ARG],
    description:
      "Read the live Cua Driver session's capture policy and effective scope.",
  },
  {
    command: "session-escalate",
    mcpSuffix: "session_escalate",
    kind: "compute_session_escalate",
    executionOperator: "local-runtime",
    executionProfile: CUA_SESSION_LIFECYCLE_PROFILE,
    args: [
      SESSION_ARG,
      {
        name: "reason",
        type: "str",
        required: true,
        choices: [
          "ax_tree_pixel_mismatch",
          "background_delivery_failed",
          "foreground_ineffective",
          "no_window_target",
          "other",
        ],
        description: "Bounded reason for the one-way desktop escalation.",
      },
      {
        name: "detail",
        type: "str",
        maxLength: 200,
        description:
          "Optional non-secret diagnostic detail, at most 200 characters.",
      },
    ],
    description:
      "Explicitly unlock desktop scope for an auto Cua Driver session after window-scoped action has been exhausted and checked.",
  },
  {
    command: "session-end",
    mcpSuffix: "session_end",
    kind: "compute_session_end",
    executionOperator: "local-runtime",
    executionProfile: CUA_SESSION_LIFECYCLE_PROFILE,
    args: [SESSION_ARG],
    description:
      "End a Cua Driver session and release its cursor, recording, and per-session configuration.",
  },
  {
    command: "screen-size",
    mcpSuffix: "screen_size",
    kind: "compute_screen_size",
    executionOperator: "local-runtime",
    executionProfile: CUA_SESSION_READ_PROFILE,
    readOnly: true,
    args: [{ ...SESSION_ARG, required: false, positional: false }],
    description:
      "Read Cua Driver desktop dimensions and scale factor. This command explicitly selects the driver provider.",
  },
  {
    command: "cursor-position",
    mcpSuffix: "cursor_position",
    kind: "compute_cursor_position",
    executionOperator: "local-runtime",
    executionProfile: CUA_SESSION_READ_PROFILE,
    readOnly: true,
    args: [{ ...SESSION_ARG, required: false, positional: false }],
    description:
      "Read the physical desktop pointer position from Cua Driver without moving it.",
  },
  {
    command: "move-cursor",
    mcpSuffix: "move_cursor",
    kind: "compute_move_cursor",
    executionOperator: "visual-coordinate",
    args: [
      {
        name: "x",
        type: "float",
        required: true,
        positional: true,
        description: "Absolute desktop x coordinate.",
      },
      {
        name: "y",
        type: "float",
        required: true,
        positional: true,
        description: "Absolute desktop y coordinate.",
      },
      { ...SESSION_ARG, required: false, positional: false },
      VISUAL_OBSERVATION_ARG,
      DRIVER_VIA_ARG,
    ],
    description:
      "Move the physical desktop pointer to an absolute point through explicitly selected Cua Driver.",
  },
  {
    command: "agent-cursor-state",
    mcpSuffix: "agent_cursor_state",
    kind: "compute_agent_cursor_state",
    executionOperator: "local-runtime",
    executionProfile: CUA_SESSION_READ_PROFILE,
    readOnly: true,
    args: [SESSION_ARG],
    description:
      "Read Cua Driver's presentation-only agent cursor state for one session.",
  },
  {
    command: "agent-cursor-enable",
    mcpSuffix: "agent_cursor_enable",
    kind: "compute_agent_cursor_enabled",
    executionOperator: "local-runtime",
    executionProfile: CUA_SESSION_LIFECYCLE_PROFILE,
    args: [
      SESSION_ARG,
      {
        name: "enabled",
        type: "bool",
        required: true,
        positional: true,
        description: "Enable or disable the presentation-only agent cursor.",
      },
    ],
    description:
      "Enable or disable Cua Driver's presentation-only agent cursor without changing task routing.",
  },
  {
    command: "agent-cursor-motion",
    mcpSuffix: "agent_cursor_motion",
    kind: "compute_agent_cursor_motion",
    executionOperator: "local-runtime",
    executionProfile: CUA_SESSION_LIFECYCLE_PROFILE,
    args: [
      SESSION_ARG,
      ...[
        "start_handle",
        "end_handle",
        "arc_size",
        "arc_flow",
        "spring",
        "glide_duration_ms",
        "dwell_after_click_ms",
        "idle_hide_ms",
        "turn_radius",
      ].map(
        (name): ComputeCommandArg => ({
          name,
          type: "nullable-float",
          description:
            "Optional presentation-only cursor motion value; null is also accepted by the driver call API.",
        }),
      ),
    ],
    description:
      "Set presentation-only Cua Driver cursor motion parameters for one session.",
  },
  {
    command: "agent-cursor-theme",
    mcpSuffix: "agent_cursor_theme",
    kind: "compute_agent_cursor_theme",
    executionOperator: "local-runtime",
    executionProfile: CUA_SESSION_LIFECYCLE_PROFILE,
    args: [
      SESSION_ARG,
      {
        name: "themeId",
        type: "str",
        required: true,
        positional: true,
        minLength: 1,
        maxLength: 200,
        description: "Cursor theme id, from 1 to 200 characters.",
      },
      {
        name: "reducedMotion",
        type: "str",
        choices: ["auto", "on", "off"],
        default: "auto",
        description: "Presentation reduced-motion policy.",
      },
    ],
    description:
      "Set Cua Driver's presentation-only agent cursor theme for one session.",
  },
  {
    command: "attach",
    mcpSuffix: "attach",
    kind: "compute_cdp_attach",
    executionOperator: "browser-semantic",
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
    executionOperator: "browser-semantic",
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
    executionOperator: "desktop-accessibility",
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
      VIA_ARG,
    ],
    description:
      "Wait for a ref, text, or state condition on one explicit app, live Uni-CLI ref, or attached CDP target.",
  },
  {
    command: "observe",
    mcpSuffix: "observe",
    kind: "compute_observe",
    executionOperator: "local-runtime",
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
    executionOperator: "local-runtime",
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
    description:
      "Assert a UI condition against the latest Uni-CLI-owned ref generation by ref, text, or state.",
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

export function getComputeCommandContractByKind(
  kind: string,
): ComputeCommandContract | undefined {
  return COMPUTE_COMMAND_CONTRACTS.find((candidate) => candidate.kind === kind);
}

export function validateComputeRequiredArguments(
  kind: string,
  params: Readonly<Record<string, unknown>>,
): string | undefined {
  const resolved = resolveComputeArguments(kind, params);
  return resolved.ok ? undefined : resolved.error;
}

export type ComputeArgumentResolution =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string };

const computeArgumentValidators = new Map<string, CompiledArgumentSchema>();
const SELECTOR_COMPATIBLE_KINDS = new Set([
  "compute_click",
  "compute_type",
  "compute_scroll",
]);
const INTERNAL_COMPUTE_TARGET_ARGUMENTS = new Set([
  "selector",
  "app",
  "windowId",
  "pid",
  "bundleId",
  "processName",
  "port",
  "webSocketDebuggerUrl",
  "targetId",
  "fresh",
]);

function validatorForComputeContract(
  contract: ComputeCommandContract,
): CompiledArgumentSchema {
  let validator = computeArgumentValidators.get(contract.kind);
  if (!validator) {
    validator = compileArgumentSchema(contract.args);
    computeArgumentValidators.set(contract.kind, validator);
  }
  return validator;
}

function formatComputeValidationError(
  contract: ComputeCommandContract,
  error: {
    instancePath?: string;
    keyword?: string;
    message?: string;
    params?: Record<string, unknown>;
  },
): string {
  const additional =
    error.keyword === "additionalProperties" &&
    typeof error.params?.additionalProperty === "string"
      ? `.${error.params.additionalProperty}`
      : "";
  const path = `${error.instancePath ?? ""}${additional}` || " arguments";
  return `${contract.command}${path} ${error.message ?? "is invalid"}`.trim();
}

/**
 * Validate the complete compute argument contract. Every compute surface
 * converges on prepareComputeRequest, so type, enum, range, length, required,
 * and additional-property failures are rejected before any provider is
 * opened. Defaults remain a surface concern: dispatch preserves the caller's
 * exact params rather than injecting schema annotations into provider calls.
 */
export function resolveComputeArguments(
  kind: string,
  params: Readonly<Record<string, unknown>>,
): ComputeArgumentResolution {
  const contract = getComputeCommandContractByKind(kind);
  if (!contract) return { ok: false, error: `unknown compute action ${kind}` };

  const resolved: Record<string, unknown> = { ...params };

  // Lower-level browser routing historically accepts a CSS selector instead
  // of a Uni-CLI ref. It remains an internal compatibility input, while the
  // public compute contract continues to prefer stable refs. Validate every
  // other key strictly and satisfy the ref precondition only for this named
  // route rather than weakening additionalProperties globally.
  const selector =
    SELECTOR_COMPATIBLE_KINDS.has(kind) &&
    typeof resolved.selector === "string" &&
    resolved.selector.trim().length > 0
      ? resolved.selector
      : undefined;
  const validationInput = { ...resolved };
  const contractArgumentNames = new Set(
    contract.args.map((argument) => argument.name),
  );
  for (const key of INTERNAL_COMPUTE_TARGET_ARGUMENTS) {
    if (!contractArgumentNames.has(key)) delete validationInput[key];
  }
  if (selector !== undefined) {
    if (validationInput.ref === undefined) {
      validationInput.ref = "__internal_browser_selector__";
    }
  }

  const validation =
    validatorForComputeContract(contract).validate(validationInput);
  if (!validation.ok) {
    return {
      ok: false,
      error: formatComputeValidationError(contract, validation.errors[0] ?? {}),
    };
  }

  if (
    kind === "compute_assert" &&
    resolved.ref === undefined &&
    resolved.text === undefined &&
    resolved.state === undefined
  ) {
    return {
      ok: false,
      error: "assert requires at least one of ref, text, or state",
    };
  }
  return { ok: true, params: resolved };
}

export function computeCommandCanMutate(
  kind: string,
  params: Readonly<Record<string, unknown>> = {},
): boolean {
  const contract = COMPUTE_COMMAND_CONTRACTS.find(
    (candidate) => candidate.kind === kind,
  );
  if (contract?.command === "screenshot") {
    return typeof params.path === "string" && params.path.trim().length > 0;
  }
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
    if (arg.type === "str[]") property.items = { type: "string" };
    if (arg.description !== undefined) property.description = arg.description;
    if (arg.default !== undefined) property.default = arg.default;
    if (arg.choices !== undefined && arg.choices.length > 0) {
      property.enum = [...arg.choices];
    }
    if (arg.minimum !== undefined) property.minimum = arg.minimum;
    if (arg.maximum !== undefined) property.maximum = arg.maximum;
    if (arg.minLength !== undefined) property.minLength = arg.minLength;
    if (arg.maxLength !== undefined) property.maxLength = arg.maxLength;
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

function jsonTypeForComputeArg(
  type: ComputeArgType | undefined,
): string | string[] {
  if (type === "str[]") return "array";
  if (type === "nullable-float") return ["number", "null"];
  if (type === "str-or-int") return ["string", "integer"];
  if (type === "int") return "integer";
  if (type === "float") return "number";
  if (type === "bool") return "boolean";
  return "string";
}
