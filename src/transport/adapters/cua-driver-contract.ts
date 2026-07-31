/**
 * @owner       src::transport::adapters::cua-driver-contract
 * @does        Validate Cua Driver portable-contract success and refusal outputs per physical tool.
 * @needs       Ajv draft-2020-12 and portable contract 0.2.0 tool schemas.
 * @feeds       CuaDriverTransport result settlement and screenshot decoding.
 * @breaks      Accepting a syntactically valid but semantically incompatible object creates false action success.
 * @invariants  Tool identity selects one cached schema; action scope and echoed targets match the request; screenshots are real PNG bytes; session receipts bind the requested session.
 * @side-effects Compiles bounded schemas once at module initialization.
 * @perf        O(output fields + screenshot bytes) per result; schema lookup is O(1).
 * @concurrency Compiled validators are immutable after initialization.
 * @test        tests/unit/transport/adapters/cua-driver.test.ts
 * @stability   experimental
 * @since       2026-07-31
 */

import Ajv2020 from "ajv/dist/2020.js";

export type CuaDriverEffectEvidence =
  | "postcondition"
  | "authoritative"
  | "pending"
  | "suspected-noop"
  | "unverified";

export type CuaDriverOutputValidation =
  | {
      status: "success";
      value: Record<string, unknown>;
      effect: CuaDriverEffectEvidence;
    }
  | { status: "refused"; reason: string }
  | { status: "invalid"; reason: string };

export interface CuaDriverFeatureProbe {
  ok: boolean;
  providerVersion?: string;
  observedToolCount: number;
  requiredToolCount: number;
  missingTools: string[];
  incompatibleInputs: Array<{
    tool: string;
    field: string;
    reason: "missing_property" | "invalid_schema" | "schema_rejected";
  }>;
}

export interface CuaOperationSpec {
  logicalActions: readonly string[];
  capabilities: readonly string[];
  capabilityDomain: "execution" | "presentation";
  readOnly: boolean;
  input: {
    properties: readonly string[];
    samples: readonly Readonly<Record<string, unknown>>[];
  };
  schema: Record<string, unknown>;
  effect: "action" | "lifecycle" | "read";
  validate?: (
    value: Record<string, unknown>,
    args: Readonly<Record<string, unknown>>,
  ) => string | undefined;
}

type Validator = ((value: unknown) => boolean) & {
  errors?: readonly {
    instancePath?: string;
    message?: string;
  }[];
};

const ACTION_EFFECTS = [
  "confirmed",
  "unverifiable",
  "pending",
  "suspected_noop",
  "refused",
] as const;

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    scope: { const: "desktop" },
    verified: { type: "boolean" },
    effect: { enum: ACTION_EFFECTS },
  },
  additionalProperties: true,
} as const;

const SESSION_STATE_PROPERTIES = {
  session: { type: "string", minLength: 1 },
  capture_scope: { enum: ["auto", "window", "desktop"] },
  effective_scope: { enum: ["window", "desktop"] },
  desktop_unlocked: { type: "boolean" },
  escalation_reason: {
    anyOf: [
      {
        enum: [
          "ax_tree_pixel_mismatch",
          "background_delivery_failed",
          "foreground_ineffective",
          "no_window_target",
          "other",
        ],
      },
      { type: "null" },
    ],
  },
  escalation_detail: {
    anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }],
  },
} as const;

const SESSION_STATE_REQUIRED = [
  "session",
  "capture_scope",
  "effective_scope",
  "desktop_unlocked",
  "escalation_reason",
  "escalation_detail",
] as const;

export const CURSOR_MOTION_FIELDS = [
  "start_handle",
  "end_handle",
  "arc_size",
  "arc_flow",
  "spring",
  "glide_duration_ms",
  "dwell_after_click_ms",
  "idle_hide_ms",
  "turn_radius",
] as const;

const CURSOR_MOTION_OUTPUT_SCHEMA = {
  type: "object",
  required: CURSOR_MOTION_FIELDS,
  properties: Object.fromEntries(
    CURSOR_MOTION_FIELDS.map((field) => [field, { type: "number" }]),
  ),
  additionalProperties: true,
} as const;

const CURSOR_POINT_SCHEMA = {
  type: "object",
  required: ["x", "y"],
  properties: {
    x: { type: "number" },
    y: { type: "number" },
  },
  additionalProperties: true,
} as const;

const CURSOR_THEME_OUTPUT_SCHEMA = {
  type: "object",
  required: ["id", "version", "profile", "reduced_motion", "fallback"],
  properties: {
    id: { type: "string" },
    version: { type: "string" },
    profile: { type: "string" },
    reduced_motion: { enum: ["auto", "on", "off"] },
    fallback: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
  },
  additionalProperties: true,
} as const;

const CURSOR_VISUAL_STATE_SCHEMA = {
  type: "object",
  required: [
    "requested_action",
    "resolved_action",
    "modifiers",
    "phase",
    "frame",
    "preempted_count",
  ],
  properties: {
    requested_action: {
      enum: [
        "idle",
        "observe",
        "click",
        "drag",
        "scroll",
        "text",
        "key",
        "navigate",
        "app",
        "transfer",
        "record",
        "system",
      ],
    },
    resolved_action: {
      enum: [
        "idle",
        "observe",
        "click",
        "drag",
        "scroll",
        "text",
        "key",
        "navigate",
        "app",
        "transfer",
        "record",
        "system",
      ],
    },
    modifiers: { type: "array", items: { type: "string" } },
    phase: { type: "string" },
    frame: { type: "integer", minimum: 0 },
    preempted_count: { type: "integer", minimum: 0 },
  },
  additionalProperties: true,
} as const;

export const CUA_DRIVER_OPERATION_SPECS: Readonly<
  Record<string, CuaOperationSpec>
> = {
  click: {
    logicalActions: ["cua_click"],
    capabilities: [
      "input.pointer.click",
      "input.pointer.click.left",
      "accessibility.element_tokens",
    ],
    capabilityDomain: "execution",
    readOnly: false,
    input: {
      properties: ["x", "y", "button", "count", "scope", "session"],
      samples: withOptionalSession(
        { x: 1, y: 2, button: "left", count: 1, scope: "desktop" },
        { x: 1.5, y: 2.5, button: "middle", count: 3, scope: "desktop" },
      ),
    },
    schema: {
      ...ACTION_SCHEMA,
      properties: {
        ...ACTION_SCHEMA.properties,
        x: { type: "number" },
        y: { type: "number" },
      },
    },
    effect: "action",
    validate: (value, args) => {
      const hasX = value.x !== undefined;
      const hasY = value.y !== undefined;
      if (hasX !== hasY) {
        return "click success must echo both x and y or neither coordinate";
      }
      return !hasX || (value.x === args.x && value.y === args.y)
        ? undefined
        : "click success echoed a different desktop point";
    },
  },
  drag: {
    logicalActions: ["cua_drag"],
    capabilities: ["input.pointer.drag"],
    capabilityDomain: "execution",
    readOnly: false,
    input: {
      properties: [
        "from_x",
        "from_y",
        "to_x",
        "to_y",
        "button",
        "duration_ms",
        "modifier",
        "steps",
        "scope",
        "session",
      ],
      samples: withOptionalSession(
        {
          from_x: 1,
          from_y: 2,
          to_x: 3,
          to_y: 4,
          scope: "desktop",
        },
        {
          from_x: 1.5,
          from_y: 2.5,
          to_x: 3.5,
          to_y: 4.5,
          button: "middle",
          duration_ms: 10_000,
          modifier: ["Shift"],
          steps: 200,
          scope: "desktop",
        },
      ),
    },
    schema: ACTION_SCHEMA,
    effect: "action",
  },
  type_text: {
    logicalActions: ["cua_type_text"],
    capabilities: [
      "input.keyboard.type",
      "input.keyboard.type.terminal_safe",
      "accessibility.element_tokens",
    ],
    capabilityDomain: "execution",
    readOnly: false,
    input: {
      properties: ["text", "scope", "session"],
      samples: withOptionalSession({ text: "probe", scope: "desktop" }),
    },
    schema: ACTION_SCHEMA,
    effect: "action",
  },
  press_key: {
    logicalActions: ["cua_press"],
    capabilities: ["input.keyboard.press", "accessibility.element_tokens"],
    capabilityDomain: "execution",
    readOnly: false,
    input: {
      properties: ["key", "modifiers", "scope", "session"],
      samples: withOptionalSession(
        { key: "Return", scope: "desktop" },
        { key: "P", modifiers: ["Control", "Shift"], scope: "desktop" },
      ),
    },
    schema: ACTION_SCHEMA,
    effect: "action",
  },
  hotkey: {
    logicalActions: ["cua_press"],
    capabilities: ["input.keyboard.hotkey"],
    capabilityDomain: "execution",
    readOnly: false,
    input: {
      properties: ["keys", "scope", "session"],
      samples: withOptionalSession({
        keys: ["Control", "P"],
        scope: "desktop",
      }),
    },
    schema: ACTION_SCHEMA,
    effect: "action",
  },
  scroll: {
    logicalActions: ["cua_scroll"],
    capabilities: ["input.pointer.scroll", "accessibility.element_tokens"],
    capabilityDomain: "execution",
    readOnly: false,
    input: {
      properties: ["x", "y", "direction", "amount", "by", "scope", "session"],
      samples: withOptionalSession(
        ...(["up", "down", "left", "right"] as const).flatMap((direction) =>
          (["line", "page"] as const).flatMap((by) => [
            { x: 1, y: 2, direction, amount: 1, by, scope: "desktop" },
            {
              x: 1.5,
              y: 2.5,
              direction,
              amount: 50,
              by,
              scope: "desktop",
            },
          ]),
        ),
      ),
    },
    schema: ACTION_SCHEMA,
    effect: "action",
  },
  get_desktop_state: {
    logicalActions: ["cua_get_desktop_state"],
    capabilities: ["screen.capture", "screen.dimensions"],
    capabilityDomain: "execution",
    readOnly: true,
    input: {
      properties: ["screenshot_out_file", "session"],
      samples: [
        {},
        { session: "unicli-doctor" },
        { screenshot_out_file: "/tmp/unicli-cua-doctor.png" },
        {
          screenshot_out_file: "/tmp/unicli-cua-doctor.png",
          session: "unicli-doctor",
        },
      ],
    },
    schema: {
      type: "object",
      required: [
        "platform",
        "display",
        "screenshot_width",
        "screenshot_height",
        "screen_width",
        "screen_height",
        "scale_factor",
        "screenshot_mime_type",
      ],
      properties: {
        platform: { enum: ["macos", "linux", "windows"] },
        display: { type: "string", minLength: 1 },
        screenshot_width: { type: "integer", minimum: 1 },
        screenshot_height: { type: "integer", minimum: 1 },
        screen_width: { type: "integer", minimum: 1 },
        screen_height: { type: "integer", minimum: 1 },
        scale_factor: { type: "number", exclusiveMinimum: 0 },
        screenshot_mime_type: { const: "image/png" },
        screenshot_png_b64: { type: "string", minLength: 12 },
        screenshot_file_path: { type: "string", minLength: 1 },
      },
      additionalProperties: true,
    },
    effect: "read",
    validate: validateDesktopState,
  },
  get_screen_size: {
    logicalActions: ["cua_get_screen_size"],
    capabilities: ["screen.dimensions"],
    capabilityDomain: "execution",
    readOnly: true,
    input: {
      properties: ["session"],
      samples: [{}, { session: "unicli-doctor" }],
    },
    schema: {
      type: "object",
      required: ["width", "height", "scale_factor"],
      properties: {
        width: { type: "number", exclusiveMinimum: 0 },
        height: { type: "number", exclusiveMinimum: 0 },
        scale_factor: { type: "number", exclusiveMinimum: 0 },
      },
      additionalProperties: true,
    },
    effect: "read",
  },
  get_cursor_position: {
    logicalActions: ["cua_get_cursor_position"],
    capabilities: ["screen.cursor.position"],
    capabilityDomain: "execution",
    readOnly: true,
    input: {
      properties: ["session"],
      samples: [{}, { session: "unicli-doctor" }],
    },
    schema: {
      type: "object",
      properties: {
        available: { type: "boolean" },
        source: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      additionalProperties: true,
    },
    effect: "read",
    validate: validateCursorPosition,
  },
  move_cursor: {
    logicalActions: ["cua_move_cursor"],
    capabilities: ["agent_cursor.move", "input.pointer.move"],
    capabilityDomain: "execution",
    readOnly: false,
    input: {
      properties: ["x", "y", "scope", "session"],
      samples: withOptionalSession(
        { x: 1, y: 2, scope: "desktop" },
        { x: 1.5, y: 2.5, scope: "desktop" },
      ),
    },
    schema: {
      ...ACTION_SCHEMA,
      properties: {
        ...ACTION_SCHEMA.properties,
        x: { type: "number" },
        y: { type: "number" },
      },
    },
    effect: "action",
    validate: (value, args) => {
      const hasX = value.x !== undefined;
      const hasY = value.y !== undefined;
      if (hasX !== hasY) {
        return "move_cursor success must echo both x and y or neither coordinate";
      }
      return !hasX || (value.x === args.x && value.y === args.y)
        ? undefined
        : "move_cursor success echoed a different desktop point";
    },
  },
  start_session: {
    logicalActions: ["cua_start_session"],
    capabilities: ["session.lifecycle.start", "session.capture_scope"],
    capabilityDomain: "execution",
    readOnly: false,
    input: {
      properties: ["session", "capture_scope", "cursor_theme"],
      samples: (["auto", "window", "desktop"] as const).flatMap(
        (capture_scope) => [
          { session: "unicli-doctor", capture_scope },
          {
            session: "unicli-doctor",
            capture_scope,
            cursor_theme: {
              theme_id: "system",
              reduced_motion: "auto",
            },
          },
        ],
      ),
    },
    schema: {
      type: "object",
      required: [...SESSION_STATE_REQUIRED, "active", "revived"],
      properties: {
        ...SESSION_STATE_PROPERTIES,
        active: { const: true },
        revived: { type: "boolean" },
      },
      additionalProperties: true,
    },
    effect: "lifecycle",
    validate: (value, args) =>
      validateSessionIdentity(value, args) ??
      (value.capture_scope === args.capture_scope
        ? undefined
        : "start_session success did not preserve the requested capture scope"),
  },
  get_session_state: {
    logicalActions: ["cua_get_session_state"],
    capabilities: ["session.capture_scope.read"],
    capabilityDomain: "execution",
    readOnly: true,
    input: {
      properties: ["session"],
      samples: [{ session: "unicli-doctor" }],
    },
    schema: {
      type: "object",
      required: SESSION_STATE_REQUIRED,
      properties: SESSION_STATE_PROPERTIES,
      additionalProperties: true,
    },
    effect: "read",
    validate: validateSessionIdentity,
  },
  escalate_session: {
    logicalActions: ["cua_escalate_session"],
    capabilities: ["session.capture_scope.escalate"],
    capabilityDomain: "execution",
    readOnly: false,
    input: {
      properties: ["session", "reason", "detail"],
      samples: (
        [
          "ax_tree_pixel_mismatch",
          "background_delivery_failed",
          "foreground_ineffective",
          "no_window_target",
          "other",
        ] as const
      ).flatMap((reason) => [
        { session: "unicli-doctor", reason },
        { session: "unicli-doctor", reason, detail: "x".repeat(200) },
      ]),
    },
    schema: {
      type: "object",
      required: SESSION_STATE_REQUIRED,
      properties: SESSION_STATE_PROPERTIES,
      additionalProperties: true,
    },
    effect: "lifecycle",
    validate: (value, args) =>
      validateSessionIdentity(value, args) ??
      (value.escalation_reason === args.reason
        ? undefined
        : "escalate_session success did not echo the requested reason") ??
      (value.escalation_detail === (args.detail ?? null)
        ? undefined
        : "escalate_session success did not echo the requested detail") ??
      (value.desktop_unlocked === true && value.effective_scope === "desktop"
        ? undefined
        : "escalate_session success did not report unlocked desktop scope"),
  },
  end_session: {
    logicalActions: ["cua_end_session"],
    capabilities: ["session.lifecycle.end"],
    capabilityDomain: "execution",
    readOnly: false,
    input: {
      properties: ["session"],
      samples: [{ session: "unicli-doctor" }],
    },
    schema: {
      type: "object",
      required: ["session", "active"],
      properties: {
        session: { type: "string", minLength: 1 },
        active: { const: false },
      },
      additionalProperties: true,
    },
    effect: "lifecycle",
    validate: validateSessionIdentity,
  },
  get_agent_cursor_state: {
    logicalActions: ["cua_get_agent_cursor_state"],
    capabilities: ["agent_cursor.state"],
    capabilityDomain: "presentation",
    readOnly: true,
    input: {
      properties: ["session"],
      samples: [{ session: "unicli-doctor" }],
    },
    schema: {
      type: "object",
      required: [
        "session",
        "enabled",
        "position",
        "theme",
        "visual_state",
        "motion",
      ],
      properties: {
        session: { type: "string" },
        enabled: { type: "boolean" },
        position: CURSOR_POINT_SCHEMA,
        theme: CURSOR_THEME_OUTPUT_SCHEMA,
        visual_state: CURSOR_VISUAL_STATE_SCHEMA,
        motion: CURSOR_MOTION_OUTPUT_SCHEMA,
      },
      additionalProperties: true,
    },
    effect: "read",
    validate: validateSessionIdentity,
  },
  set_agent_cursor_enabled: {
    logicalActions: ["cua_set_agent_cursor_enabled"],
    capabilities: ["agent_cursor.set_enabled"],
    capabilityDomain: "presentation",
    readOnly: false,
    input: {
      properties: ["session", "enabled"],
      samples: [
        { session: "unicli-doctor", enabled: true },
        { session: "unicli-doctor", enabled: false },
      ],
    },
    schema: {
      type: "object",
      required: ["session", "enabled"],
      properties: {
        session: { type: "string" },
        enabled: { type: "boolean" },
      },
      additionalProperties: true,
    },
    effect: "lifecycle",
    validate: (value, args) =>
      validateSessionIdentity(value, args) ??
      (value.enabled === args.enabled
        ? undefined
        : "agent cursor enabled receipt does not match the request"),
  },
  set_agent_cursor_motion: {
    logicalActions: ["cua_set_agent_cursor_motion"],
    capabilities: ["agent_cursor.set_motion"],
    capabilityDomain: "presentation",
    readOnly: false,
    input: {
      properties: ["session", ...CURSOR_MOTION_FIELDS],
      samples: [
        { session: "unicli-doctor" },
        Object.fromEntries([
          ["session", "unicli-doctor"],
          ...CURSOR_MOTION_FIELDS.map((field) => [field, 1]),
        ]),
        Object.fromEntries([
          ["session", "unicli-doctor"],
          ...CURSOR_MOTION_FIELDS.map((field) => [field, null]),
        ]),
      ],
    },
    schema: {
      type: "object",
      required: ["session", "motion"],
      properties: {
        session: { type: "string" },
        motion: CURSOR_MOTION_OUTPUT_SCHEMA,
      },
      additionalProperties: true,
    },
    effect: "lifecycle",
    validate: validateCursorMotionReceipt,
  },
  set_agent_cursor_theme: {
    logicalActions: ["cua_set_agent_cursor_theme"],
    capabilities: ["agent_cursor.set_theme"],
    capabilityDomain: "presentation",
    readOnly: false,
    input: {
      properties: ["session", "theme_id", "reduced_motion"],
      samples: (["auto", "on", "off"] as const).map((reduced_motion) => ({
        session: "unicli-doctor",
        theme_id: "system",
        reduced_motion,
      })),
    },
    schema: {
      type: "object",
      required: ["session", "theme"],
      properties: {
        session: { type: "string" },
        theme: CURSOR_THEME_OUTPUT_SCHEMA,
      },
      additionalProperties: true,
    },
    effect: "lifecycle",
    validate: validateCursorThemeReceipt,
  },
};

export const CUA_DRIVER_TOOL_NAMES = Object.freeze(
  Object.keys(CUA_DRIVER_OPERATION_SPECS),
);

export const CUA_DRIVER_LOGICAL_ACTIONS = Object.freeze([
  ...new Set(
    Object.values(CUA_DRIVER_OPERATION_SPECS).flatMap(
      (spec) => spec.logicalActions,
    ),
  ),
]);

export const CUA_DRIVER_READ_ONLY_ACTIONS = new Set(
  Object.values(CUA_DRIVER_OPERATION_SPECS)
    .filter((spec) => spec.readOnly)
    .flatMap((spec) => spec.logicalActions),
);

const VALIDATORS = compileValidators(CUA_DRIVER_OPERATION_SPECS);

function withOptionalSession(
  ...samples: readonly Readonly<Record<string, unknown>>[]
): readonly Readonly<Record<string, unknown>>[] {
  return samples.flatMap((sample) => [
    sample,
    { ...sample, session: "unicli-doctor" },
  ]);
}

export function probeCuaDriverFeatures(value: unknown): CuaDriverFeatureProbe {
  const document = isRecord(value) ? value : {};
  const tools = Array.isArray(document.tools) ? document.tools : [];
  const schemas = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
    if (
      !isRecord(tool) ||
      typeof tool.name !== "string" ||
      !isRecord(tool.input_schema)
    ) {
      continue;
    }
    schemas.set(tool.name, tool.input_schema);
  }

  const missingTools: string[] = [];
  const incompatibleInputs: CuaDriverFeatureProbe["incompatibleInputs"] = [];
  const AjvCtor = ((Ajv2020 as unknown as { default?: unknown }).default ??
    Ajv2020) as new (options: {
    strict: boolean;
    allErrors: boolean;
    validateFormats?: boolean;
  }) => { compile(schema: unknown): Validator };
  const ajv = new AjvCtor({
    strict: false,
    allErrors: true,
    validateFormats: false,
  });
  for (const [tool, spec] of Object.entries(CUA_DRIVER_OPERATION_SPECS)) {
    const requirement = spec.input;
    const schema = schemas.get(tool);
    if (!schema) {
      missingTools.push(tool);
      continue;
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const field of requirement.properties) {
      if (!(field in properties)) {
        incompatibleInputs.push({
          tool,
          field,
          reason: "missing_property",
        });
      }
    }
    try {
      const validate = ajv.compile(schema);
      if (requirement.samples.some((sample) => !validate(sample))) {
        incompatibleInputs.push({
          tool,
          field: "$sample",
          reason: "schema_rejected",
        });
      }
    } catch {
      incompatibleInputs.push({
        tool,
        field: "$schema",
        reason: "invalid_schema",
      });
    }
  }

  return {
    ok: missingTools.length === 0 && incompatibleInputs.length === 0,
    ...(typeof document.version === "string"
      ? { providerVersion: document.version }
      : {}),
    observedToolCount: schemas.size,
    requiredToolCount: CUA_DRIVER_TOOL_NAMES.length,
    missingTools,
    incompatibleInputs,
  };
}

export function validateCuaDriverOutput(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  value: Record<string, unknown>,
): CuaDriverOutputValidation {
  if (isRecord(value.refusal)) {
    return {
      status: "refused",
      reason: boundedJson(value.refusal),
    };
  }
  if (value.effect === "refused") {
    return {
      status: "refused",
      reason: "provider returned effect=refused",
    };
  }
  if (value.status === "refused") {
    return {
      status: "refused",
      reason: "provider returned status=refused",
    };
  }

  const spec = CUA_DRIVER_OPERATION_SPECS[tool];
  const validate = VALIDATORS.get(tool);
  if (!spec || !validate) {
    return {
      status: "invalid",
      reason: `portable contract has no success schema for tool ${JSON.stringify(tool)}`,
    };
  }
  if (!validate(value)) {
    const detail = (validate.errors ?? [])
      .slice(0, 3)
      .map(
        (error) =>
          `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      )
      .join("; ");
    return {
      status: "invalid",
      reason: `${tool} success output violates contract 0.2.0${detail ? `: ${detail}` : ""}`,
    };
  }
  const semanticError = spec.validate?.(value, args);
  if (semanticError) return { status: "invalid", reason: semanticError };

  if (spec.effect === "lifecycle") {
    return { status: "success", value, effect: "authoritative" };
  }
  if (spec.effect === "read") {
    return { status: "success", value, effect: "unverified" };
  }
  if (value.effect === "suspected_noop") {
    if (value.verified === true) {
      return {
        status: "invalid",
        reason:
          "suspected_noop conflicts with verified=true in Cua Driver output",
      };
    }
    return { status: "success", value, effect: "suspected-noop" };
  }
  if (value.effect === "confirmed" && value.verified !== true) {
    return {
      status: "invalid",
      reason: "effect=confirmed requires verified=true",
    };
  }
  if (value.effect === "unverifiable" && value.verified === true) {
    return {
      status: "invalid",
      reason: "effect=unverifiable conflicts with verified=true",
    };
  }
  if (value.effect === "pending") {
    if (value.verified === true) {
      return {
        status: "invalid",
        reason: "effect=pending conflicts with verified=true",
      };
    }
    return { status: "success", value, effect: "pending" };
  }
  return {
    status: "success",
    value,
    effect: value.verified === true ? "postcondition" : "unverified",
  };
}

export function decodeCuaPng(value: unknown): Buffer | undefined {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64");
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length < 45 ||
    !bytes.subarray(0, pngSignature.length).equals(pngSignature)
  ) {
    return undefined;
  }
  let offset = pngSignature.length;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return undefined;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return undefined;
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (width === 0 || height === 0) return undefined;
      sawHeader = true;
    }
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.length) return undefined;
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  return sawHeader && sawData && sawEnd ? bytes : undefined;
}

function compileValidators(
  specs: Readonly<Record<string, CuaOperationSpec>>,
): Map<string, Validator> {
  const AjvCtor = ((Ajv2020 as unknown as { default?: unknown }).default ??
    Ajv2020) as new (options: {
    strict: boolean;
    allErrors: boolean;
    validateFormats?: boolean;
  }) => { compile(schema: unknown): Validator };
  const ajv = new AjvCtor({ strict: true, allErrors: true });
  return new Map(
    Object.entries(specs).map(([tool, spec]) => [
      tool,
      ajv.compile(spec.schema),
    ]),
  );
}

function validateDesktopState(
  value: Record<string, unknown>,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  const requestedPath = args.screenshot_out_file;
  if (typeof requestedPath === "string") {
    return value.screenshot_file_path === requestedPath
      ? undefined
      : "desktop-state success did not return the requested screenshot file path";
  }
  const png = decodeCuaPng(value.screenshot_png_b64);
  if (!png) return "desktop-state inline screenshot is not a complete PNG";
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width === value.screenshot_width && height === value.screenshot_height
    ? undefined
    : "desktop-state screenshot dimensions do not match its PNG IHDR";
}

function validateSessionIdentity(
  value: Record<string, unknown>,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  return value.session === args.session
    ? undefined
    : "session success does not match the requested session";
}

function validateCursorPosition(
  value: Record<string, unknown>,
): string | undefined {
  const hasX = value.x !== undefined;
  const hasY = value.y !== undefined;
  if (hasX !== hasY) {
    return "cursor-position success must return both x and y or neither coordinate";
  }
  if (value.available === true && !hasX) {
    return "cursor-position success reported available=true without coordinates";
  }
  if (value.available === false && hasX) {
    return "cursor-position success reported available=false with coordinates";
  }
  return undefined;
}

function validateCursorMotionReceipt(
  value: Record<string, unknown>,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  const identityError = validateSessionIdentity(value, args);
  if (identityError) return identityError;
  if (!isRecord(value.motion)) {
    return "agent cursor motion receipt is missing motion state";
  }
  for (const field of CURSOR_MOTION_FIELDS) {
    if (args[field] !== undefined && args[field] !== null) {
      if (value.motion[field] !== args[field]) {
        return `agent cursor motion receipt does not preserve requested ${field}`;
      }
    }
  }
  return undefined;
}

function validateCursorThemeReceipt(
  value: Record<string, unknown>,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  const identityError = validateSessionIdentity(value, args);
  if (identityError) return identityError;
  if (!isRecord(value.theme)) {
    return "agent cursor theme receipt is missing theme state";
  }
  if (value.theme.id !== args.theme_id) {
    return "agent cursor theme receipt does not preserve theme_id";
  }
  const reducedMotion = args.reduced_motion ?? "auto";
  return value.theme.reduced_motion === reducedMotion
    ? undefined
    : "agent cursor theme receipt does not preserve reduced_motion";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedJson(value: unknown, max = 2_000): string {
  const text = JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
