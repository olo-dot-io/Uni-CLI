/**
 * @owner       src::mcp::profiles::browser-control-input
 * @does        Define each direct browser MCP input once and derive both strict runtime parsing and advertised JSON Schema from it.
 * @needs       zod, Chrome content-search protocol bounds, MCP tool schema contract
 * @feeds       src/mcp/profiles/browser-control.ts
 * @breaks      Invalid, unbounded, cross-provider, or stale-capability-shaped input throws one structured invalid_input error before browser acquisition.
 * @invariants  Runtime validation and advertised schemas share one source; every object rejects undeclared keys; URLs are absolute HTTP(S); capability refs carry one UUID snapshot and safe local index; click accepts exactly one ref or complete viewport point.
 * @side-effects none
 * @perf        O(argument count), except explicit Unicode code-point counting for bounded keystroke input.
 * @test        tests/unit/mcp/browser-control.test.ts, tests/unit/mcp/tools.test.ts
 * @stability   experimental
 * @since       2026-07-16
 */

import { z } from "zod";

import {
  CHROME_CONTENT_SEARCH_DEFAULT_MAX_CHARS_PER_TAB,
  CHROME_CONTENT_SEARCH_DEFAULT_MAX_RESULTS,
  CHROME_CONTENT_SEARCH_DEFAULT_MAX_TABS,
  CHROME_CONTENT_SEARCH_MAX_CHARS_PER_TAB,
  CHROME_CONTENT_SEARCH_MAX_RESULTS,
  CHROME_CONTENT_SEARCH_MAX_TABS,
} from "../../browser/chrome-native-protocol.js";
import type { McpTool } from "../tools.js";

export type BrowserControlParams = Record<string, unknown>;

interface BrowserControlInput {
  inputSchema: McpTool["inputSchema"];
  parse(args: BrowserControlParams): BrowserControlParams;
}

type ProjectInput = (value: BrowserControlParams) => BrowserControlParams;

const tabId = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe("Chrome tab id returned by computer-use.browser_tabs.");
const capabilityRef = z
  .string()
  .trim()
  .min(39)
  .max(48)
  .regex(
    /^p[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]*$/i,
    "must be a snapshot-scoped p<uuid>:<index> ref from browser_state",
  )
  .describe("Snapshot-scoped ref returned by computer-use.browser_state.");
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine(isHttpUrl, "must be an absolute HTTP(S) URL")
  .describe("Absolute HTTP(S) destination URL.");

const empty = defineInput(z.strictObject({}));
const tab = defineInput(z.strictObject({ tab_id: tabId }));
const state = defineInput(
  z.strictObject({
    tab_id: tabId.optional(),
    max_refs: z.number().int().min(1).max(1_000).default(300),
    max_depth: z.number().int().min(1).max(100).default(50),
  }),
);
const navigate = defineInput(
  z.strictObject({
    tab_id: tabId.optional(),
    url: httpUrl,
    settle_ms: z.number().int().min(0).max(30_000).default(0),
  }),
  (value) => ({ ...value, url: new URL(value.url as string).href }),
);
const screenshot = defineInput(
  z
    .strictObject({
      tab_id: tabId.optional(),
      format: z.enum(["png", "jpeg", "webp"]).default("png"),
      quality: z.number().int().min(0).max(100).optional(),
      full_page: z.boolean().default(false),
    })
    .superRefine((value, context) => {
      if (value.format === "png" && value.quality !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["quality"],
          message: "is only valid for jpeg or webp screenshots",
        });
      }
    }),
);
const click = defineInput(
  z.union([
    z.strictObject({ tab_id: tabId.optional(), ref: capabilityRef }),
    z.strictObject({
      tab_id: tabId.optional(),
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative(),
    }),
  ]),
  projectCapabilityRef,
);
const refAction = defineInput(
  z.strictObject({ tab_id: tabId.optional(), ref: capabilityRef }),
  projectCapabilityRef,
);
const key = defineInput(
  z.strictObject({
    tab_id: tabId.optional(),
    key: z.string().trim().min(1).max(64),
    modifiers: z
      .array(z.enum(["alt", "control", "meta", "shift"]))
      .max(4)
      .default([])
      .refine((values) => new Set(values).size === values.length, {
        message: "must not contain duplicate modifiers",
      }),
  }),
);
const scroll = defineInput(
  z.strictObject({
    tab_id: tabId.optional(),
    direction: z.enum(["down", "up", "bottom", "top"]),
  }),
);
const type = defineInput(
  z
    .strictObject({
      tab_id: tabId.optional(),
      ref: capabilityRef,
      text: z.string().min(1).max(20_000),
      mode: z.enum(["insert_text", "keystrokes"]).default("insert_text"),
    })
    .superRefine((value, context) => {
      if (value.mode === "keystrokes" && [...value.text].length > 2_000) {
        context.addIssue({
          code: "custom",
          path: ["text"],
          message: "keystrokes mode is limited to 2000 Unicode characters",
        });
      }
    }),
  projectCapabilityRef,
);
const search = defineInput(
  z
    .strictObject({
      query: z.string().trim().min(1).max(512),
      include_history: z.boolean().default(false),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(CHROME_CONTENT_SEARCH_MAX_RESULTS)
        .default(CHROME_CONTENT_SEARCH_DEFAULT_MAX_RESULTS),
      max_tabs: z
        .number()
        .int()
        .min(1)
        .max(CHROME_CONTENT_SEARCH_MAX_TABS)
        .default(CHROME_CONTENT_SEARCH_DEFAULT_MAX_TABS),
      max_chars_per_tab: z
        .number()
        .int()
        .min(1_024)
        .max(CHROME_CONTENT_SEARCH_MAX_CHARS_PER_TAB)
        .default(CHROME_CONTENT_SEARCH_DEFAULT_MAX_CHARS_PER_TAB),
      history_start_time: z.number().finite().nonnegative().optional(),
      history_end_time: z.number().finite().nonnegative().optional(),
    })
    .superRefine((value, context) => {
      if (
        !value.include_history &&
        (value.history_start_time !== undefined ||
          value.history_end_time !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["include_history"],
          message: "must be true when a history time bound is present",
        });
      }
      if (
        value.history_start_time !== undefined &&
        value.history_end_time !== undefined &&
        value.history_start_time > value.history_end_time
      ) {
        context.addIssue({
          code: "custom",
          path: ["history_start_time"],
          message: "must not exceed history_end_time",
        });
      }
    }),
);
const presence = defineInput(
  z
    .strictObject({
      tab_id: tabId,
      visible: z.boolean(),
      label: z.string().trim().min(1).max(80).optional(),
    })
    .superRefine((value, context) => {
      if (!value.visible && value.label !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["label"],
          message: "is only valid when visible is true",
        });
      }
    }),
);
const cursor = defineInput(
  z.strictObject({
    tab_id: tabId,
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    visible: z.boolean().default(true),
  }),
);
const dialog = defineInput(
  z
    .strictObject({
      tab_id: tabId,
      action: z.enum(["accept", "dismiss"]),
      dialog_id: z.string().trim().min(1).max(120).optional(),
      prompt_text: z.string().max(20_000).optional(),
    })
    .superRefine((value, context) => {
      if (value.action === "dismiss" && value.prompt_text !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["prompt_text"],
          message: "is only valid when accepting a prompt dialog",
        });
      }
    }),
);
const downloads = defineInput(
  z.strictObject({
    tab_id: tabId,
    limit: z.number().int().min(1).max(50).default(20),
  }),
);

export const BROWSER_CONTROL_INPUT = Object.freeze({
  empty,
  tab,
  state,
  navigate,
  screenshot,
  click,
  refAction,
  type,
  key,
  scroll,
  search,
  presence,
  cursor,
  dialog,
  downloads,
});

export class BrowserControlInputError extends Error {
  readonly code = "invalid_input";
  readonly retryable = false;
  readonly exitCode = 2;
  readonly suggestion =
    "Use the published MCP input schema and keep every value within its documented bound.";

  constructor(message: string) {
    super(message);
    this.name = "BrowserControlInputError";
  }
}

function defineInput(
  schema: z.ZodType,
  project?: ProjectInput,
): BrowserControlInput {
  return Object.freeze({
    inputSchema: inputSchemaFor(schema),
    parse: (args: BrowserControlParams) => {
      const result = schema.safeParse(args);
      if (!result.success) throw inputError(result.error);
      const parsed = requireParams(result.data);
      return project ? project(parsed) : parsed;
    },
  });
}

function inputSchemaFor(schema: z.ZodType): McpTool["inputSchema"] {
  const generated = z.toJSONSchema(schema, { target: "draft-7" });
  const { $schema: _schema, ...inputSchema } = generated;
  return inputSchema as McpTool["inputSchema"];
}

function projectCapabilityRef(
  value: BrowserControlParams,
): BrowserControlParams {
  if (typeof value.ref !== "string") return value;
  const ref = value.ref as string;
  const separator = ref.lastIndexOf(":");
  const localRef = Number(ref.slice(separator + 1));
  if (!Number.isSafeInteger(localRef) || localRef < 1) {
    throw new BrowserControlInputError(
      "ref index exceeds the safe integer range",
    );
  }
  return {
    ...value,
    snapshot_id: ref.slice(1, separator),
    local_ref: localRef,
  };
}

function inputError(error: z.ZodError): BrowserControlInputError {
  const issue = error.issues[0];
  const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return new BrowserControlInputError(
    `${path}${issue?.message ?? "browser control input is invalid"}`,
  );
}

function requireParams(value: unknown): BrowserControlParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrowserControlInputError(
      "browser control input must be an object",
    );
  }
  return value as BrowserControlParams;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
