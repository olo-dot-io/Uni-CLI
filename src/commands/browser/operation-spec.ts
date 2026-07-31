/**
 * @owner       src::commands::browser::operation-spec
 * @does        Declare the stable task-level browser operation and argument surface once for discovery, contracts, and Commander conformance.
 * @needs       shared command contract scalar and argument types
 * @feeds       core discovery catalog and browser command conformance tests
 * @breaks      Missing or incorrect rows make existing browser capabilities undiscoverable or produce non-runnable Agent plans.
 * @invariants  Each row names an executable `unicli browser ...` path, its complete command-local argument contract, one semantic family, one operator, and its conservative effect.
 * @side-effects None.
 * @perf        O(1) immutable catalog construction; callers may build a bounded Map for lookup.
 * @concurrency Immutable.
 * @test        tests/unit/commands/browser-operation-spec.test.ts, tests/unit/commands/do.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

import type {
  AdapterArg,
  AdapterCommand,
  ExecutionOperator,
  OperationEffect,
  OperationFamily,
} from "../../types.js";

export interface BrowserOperationArg extends AdapterArg {
  /** Exact Commander long flag. Omitted for positional arguments. */
  readonly flags?: string;
}

type BrowserActuation =
  | "none"
  | "protocol-call"
  | "dom-action"
  | "screen-capture";
type BrowserInteractionImpact = "background" | "target-scoped" | "foreground";

export interface BrowserOperationSpec {
  readonly command: string;
  readonly description: string;
  readonly args: readonly BrowserOperationArg[];
  readonly operation_family: OperationFamily;
  readonly execution_operator: ExecutionOperator;
  readonly operation_effect: OperationEffect;
  readonly idempotency: AdapterCommand["idempotency"];
  readonly capability: string;
  readonly perception: "structured-data" | "dom-accessibility" | "pixels";
  readonly actuation: BrowserActuation;
  readonly verification: "protocol-result" | "dom-state" | "pixel-observation";
  readonly interaction_impact: BrowserInteractionImpact;
  readonly source_path:
    | "src/commands/browser/actions.ts"
    | "src/commands/browser/authoring.ts";
}

interface BrowserOperationConfig {
  readonly args?: readonly BrowserOperationArg[];
  readonly effect?: OperationEffect;
  readonly idempotency?: AdapterCommand["idempotency"];
  readonly actuation?: BrowserActuation;
  readonly interactionImpact?: BrowserInteractionImpact;
}

function positional(
  name: string,
  description: string,
  config: Omit<BrowserOperationArg, "name" | "description" | "positional"> = {},
): BrowserOperationArg {
  return { name, description, positional: true, ...config };
}

function option(
  name: string,
  flags: string,
  description: string,
  config: Omit<
    BrowserOperationArg,
    "name" | "flags" | "description" | "positional"
  > = {},
): BrowserOperationArg {
  return { name, flags, description, positional: false, ...config };
}

function protocol(
  command: string,
  description: string,
  operation_family: OperationFamily,
  config: BrowserOperationConfig = {},
): BrowserOperationSpec {
  const operationEffect = config.effect ?? "read";
  return {
    command,
    description,
    args: config.args ?? [],
    operation_family,
    execution_operator: "browser-protocol",
    operation_effect: operationEffect,
    idempotency: config.idempotency ?? "guaranteed",
    capability: `cdp-browser.${command.replaceAll(" ", "-")}`,
    perception: "structured-data",
    actuation:
      config.actuation ??
      (operationEffect === "read" ? "none" : "protocol-call"),
    verification: "protocol-result",
    interaction_impact: config.interactionImpact ?? "background",
    source_path:
      command === "network" || command === "analyze"
        ? "src/commands/browser/authoring.ts"
        : "src/commands/browser/actions.ts",
  };
}

function semantic(
  command: string,
  description: string,
  operation_family: OperationFamily,
  config: BrowserOperationConfig = {},
): BrowserOperationSpec {
  const operationEffect = config.effect ?? "read";
  return {
    command,
    description,
    args: config.args ?? [],
    operation_family,
    execution_operator: "browser-semantic",
    operation_effect: operationEffect,
    idempotency: config.idempotency ?? "guaranteed",
    capability: `cdp-browser.${command.replaceAll(" ", "-")}`,
    perception: "dom-accessibility",
    actuation:
      config.actuation ?? (operationEffect === "read" ? "none" : "dom-action"),
    verification: "dom-state",
    interaction_impact:
      config.interactionImpact ??
      (operationEffect === "read" ? "background" : "target-scoped"),
    source_path: "src/commands/browser/actions.ts",
  };
}

function visual(
  command: string,
  description: string,
  config: BrowserOperationConfig,
): BrowserOperationSpec {
  return {
    command,
    description,
    args: config.args ?? [],
    operation_family: "capture",
    execution_operator: "visual-observation",
    operation_effect: config.effect ?? "read",
    idempotency: config.idempotency ?? "guaranteed",
    capability: `cdp-browser.${command}`,
    perception: "pixels",
    actuation: "screen-capture",
    verification: "pixel-observation",
    interaction_impact: config.interactionImpact ?? "background",
    source_path: "src/commands/browser/actions.ts",
  };
}

const ref = (description: string): BrowserOperationArg =>
  positional("ref", description, { required: true, minLength: 1 });

const renderAwareArgs = (
  screenshotBeforeRenderAware = false,
): readonly BrowserOperationArg[] => {
  const renderAware = option(
    "renderAware",
    "--render-aware",
    "Wait for rendered page evidence to stabilize before returning.",
    { type: "bool" },
  );
  const screenshot = option(
    "screenshot",
    "--no-screenshot",
    "Capture screenshot evidence while waiting for rendered stability.",
    { type: "bool", default: true },
  );
  const timing = [
    option(
      "stabilityMs",
      "--stability-ms <n>",
      "Rendered-state stability window in milliseconds.",
      { type: "int", default: 500, minimum: 0 },
    ),
    option(
      "timeoutMs",
      "--timeout-ms <n>",
      "Rendered-state timeout in milliseconds.",
      { type: "int", default: 3000, minimum: 0 },
    ),
    option(
      "pollMs",
      "--poll-ms <n>",
      "Rendered-state polling interval in milliseconds.",
      { type: "int", default: 100, minimum: 1 },
    ),
  ];
  return screenshotBeforeRenderAware
    ? [screenshot, renderAware, ...timing]
    : [renderAware, screenshot, ...timing];
};

export const BROWSER_OPERATION_SPECS: readonly BrowserOperationSpec[] =
  Object.freeze([
    semantic(
      "open",
      "Navigate the selected broker-owned browser renderer to one URL without switching to desktop control.",
      "navigate",
      {
        idempotency: "conditional",
        args: [
          positional("url", "Absolute URL to navigate to.", {
            type: "str",
            required: true,
            format: "uri",
          }),
        ],
      },
    ),
    semantic(
      "back",
      "Navigate the selected browser renderer back in its page history.",
      "navigate",
      { idempotency: "conditional" },
    ),
    semantic(
      "state",
      "Read the current renderer URL and DOM accessibility snapshot with stable page refs.",
      "get",
      {
        args: [
          option(
            "interactive",
            "--interactive",
            "Only return interactive elements.",
            { type: "bool" },
          ),
          option("compact", "--compact", "Omit decorative nodes.", {
            type: "bool",
          }),
        ],
      },
    ),
    semantic(
      "query",
      "Read bounded text, value, or attributes from one verified browser snapshot ref.",
      "get",
      {
        args: [
          ref("Verified ref from the latest browser state snapshot."),
          option("kind", "--kind <kind>", "DOM value kind to return.", {
            type: "str",
            default: "text",
            choices: ["text", "value", "attributes"],
          }),
        ],
      },
    ),
    visual(
      "screenshot",
      "Capture pixels from the selected browser renderer, optionally writing the image artifact to a caller path.",
      {
        effect: "local_file",
        args: [
          positional("path", "Optional screenshot output path.", {
            type: "str",
            "x-unicli-kind": "path",
          }),
          option(
            "fullPage",
            "--full-page",
            "Capture the full scrollable page.",
            { type: "bool" },
          ),
        ],
      },
    ),
    visual(
      "evidence",
      "Capture a renderer-scoped DOM, network, stability, and optional screenshot evidence packet.",
      {
        effect: "local_file",
        idempotency: "none",
        args: [
          option(
            "screenshotDir",
            "--screenshot-dir <path>",
            "Directory for screenshot evidence artifacts.",
            { type: "str", "x-unicli-kind": "path" },
          ),
          ...renderAwareArgs(true),
        ],
      },
    ),
    protocol(
      "console",
      "Read bounded console messages and page errors from the selected browser renderer.",
      "list",
      {
        args: [
          option(
            "clear",
            "--clear",
            "Clear captured console entries after reading.",
            { type: "bool" },
          ),
          option("max", "--max <n>", "Maximum console entries to return.", {
            type: "int",
            default: 50,
            minimum: 1,
          }),
          option(
            "textMax",
            "--text-max <n>",
            "Maximum text characters per entry.",
            { type: "int", default: 1000, minimum: 1 },
          ),
        ],
      },
    ),
    protocol(
      "cdp",
      "Invoke one read-only allowlisted Chrome DevTools Protocol method on the selected renderer.",
      "get",
      {
        args: [
          positional("method", "Allowlisted Chrome DevTools Protocol method.", {
            type: "str",
            required: true,
            minLength: 1,
          }),
          positional("params", "Optional JSON object of CDP parameters.", {
            type: "str",
          }),
        ],
      },
    ),
    protocol(
      "dialogs",
      "List provider-owned JavaScript dialog state for the selected renderer.",
      "list",
      {
        args: [
          option(
            "clearRecent",
            "--clear-recent",
            "Clear recent dialog records after reading.",
            { type: "bool" },
          ),
        ],
      },
    ),
    protocol(
      "dialog",
      "Accept, dismiss, or answer a pending provider-owned JavaScript dialog.",
      "invoke",
      {
        effect: "unknown_write",
        idempotency: "none",
        args: [
          positional("action", "Dialog action.", {
            type: "str",
            required: true,
            choices: ["accept", "dismiss"],
          }),
          positional("dialogId", "Optional provider-owned dialog id.", {
            type: "str",
          }),
          option(
            "prompt",
            "--prompt <text>",
            "Prompt response text for prompt dialogs.",
            { type: "str" },
          ),
        ],
      },
    ),
    semantic(
      "click",
      "Click one verified DOM accessibility ref in the selected browser renderer.",
      "invoke",
      {
        effect: "unknown_write",
        idempotency: "none",
        args: [
          ref("Verified clickable ref from the latest browser state snapshot."),
        ],
      },
    ),
    semantic(
      "type",
      "Type text into one verified DOM accessibility ref in the selected browser renderer.",
      "update",
      {
        effect: "unknown_write",
        idempotency: "none",
        args: [
          ref("Verified editable ref from the latest browser state snapshot."),
          positional("text", "Text to type into the target.", {
            type: "str",
            required: true,
          }),
        ],
      },
    ),
    semantic(
      "keys",
      "Send a key combination to the selected browser renderer.",
      "invoke",
      {
        effect: "unknown_write",
        idempotency: "none",
        args: [
          positional("key", "Key or modifier combination to press.", {
            type: "str",
            required: true,
            minLength: 1,
          }),
        ],
      },
    ),
    semantic(
      "scroll",
      "Scroll the selected browser renderer through its semantic browser provider.",
      "invoke",
      {
        effect: "unknown_write",
        idempotency: "none",
        args: [
          positional("direction", "Scroll direction.", {
            type: "str",
            default: "down",
            choices: ["down", "up", "bottom", "top"],
          }),
          option("auto", "--auto", "Auto-scroll to the page bottom.", {
            type: "bool",
          }),
          option("max", "--max <n>", "Maximum auto-scroll iterations.", {
            type: "int",
            default: 10,
            minimum: 1,
          }),
        ],
      },
    ),
    protocol(
      "get title",
      "Read the current browser renderer title through its broker protocol.",
      "get",
    ),
    protocol(
      "get url",
      "Read the current browser renderer URL and connection-target evidence.",
      "get",
    ),
    semantic(
      "get text",
      "Read text content from one browser snapshot ref.",
      "get",
      { args: [ref("Verified ref from the latest browser state snapshot.")] },
    ),
    semantic(
      "get value",
      "Read the current value from one browser form-control ref.",
      "get",
      {
        args: [
          ref(
            "Verified form-control ref from the latest browser state snapshot.",
          ),
        ],
      },
    ),
    semantic(
      "get html",
      "Read bounded rendered HTML from the current page or one CSS selector.",
      "get",
      {
        args: [
          positional(
            "selector",
            "Optional CSS selector for the content root.",
            {
              type: "str",
              "x-unicli-kind": "selector",
            },
          ),
        ],
      },
    ),
    semantic(
      "get attributes",
      "Read all attributes from one browser snapshot ref.",
      "get",
      { args: [ref("Verified ref from the latest browser state snapshot.")] },
    ),
    semantic(
      "wait",
      "Wait for a bounded time, selector, or text condition in the selected renderer.",
      "get",
      {
        args: [
          positional("type", "Wait condition type.", {
            type: "str",
            required: true,
            choices: ["time", "selector", "text"],
          }),
          positional("value", "Condition value.", { type: "str" }),
          option("timeout", "--timeout <ms>", "Timeout in milliseconds.", {
            type: "int",
            default: 10000,
            minimum: 0,
          }),
        ],
      },
    ),
    protocol(
      "eval",
      "Evaluate caller-supplied JavaScript in the selected renderer without changing execution provider.",
      "invoke",
      {
        effect: "unknown_write",
        idempotency: "none",
        args: [
          positional("js", "JavaScript source to evaluate in the page.", {
            type: "str",
            required: true,
            minLength: 1,
          }),
        ],
      },
    ),
    semantic(
      "select",
      "Select one option in a verified DOM select ref.",
      "update",
      {
        effect: "unknown_write",
        idempotency: "none",
        args: [
          ref("Verified select ref from the latest browser state snapshot."),
          positional("option", "Option value to select.", {
            type: "str",
            required: true,
          }),
        ],
      },
    ),
    semantic(
      "upload",
      "Attach one allowed local file to a verified browser file-input ref.",
      "create",
      {
        effect: "unknown_write",
        idempotency: "none",
        args: [
          ref(
            "Verified file-input ref from the latest browser state snapshot.",
          ),
          positional("path", "Allowed local file path to attach.", {
            type: "str",
            required: true,
            "x-unicli-kind": "path",
          }),
        ],
      },
    ),
    semantic(
      "hover",
      "Hover one verified DOM ref in the selected browser renderer.",
      "invoke",
      {
        effect: "unknown_write",
        idempotency: "none",
        args: [ref("Verified ref from the latest browser state snapshot.")],
      },
    ),
    semantic(
      "observe",
      "Rank candidate DOM actions for a natural-language goal and append the observation to a local cache.",
      "search",
      {
        effect: "local_file",
        idempotency: "none",
        actuation: "none",
        interactionImpact: "background",
        args: [
          positional("query", "Natural-language action goal.", {
            type: "str",
            required: true,
            minLength: 1,
          }),
          option(
            "topK",
            "--top-k <n>",
            "Number of ranked candidates to return.",
            { type: "int", default: 5, minimum: 1 },
          ),
          option("cache", "--cache <path>", "Observation cache file.", {
            type: "str",
            "x-unicli-kind": "path",
          }),
        ],
      },
    ),
    semantic(
      "find",
      "Find rendered DOM elements by CSS and allocate browser refs on demand.",
      "search",
      {
        args: [
          option("css", "--css <selector>", "CSS selector to query.", {
            type: "str",
            required: true,
            "x-unicli-kind": "selector",
          }),
          option("limit", "--limit <n>", "Maximum matches to return.", {
            type: "int",
            default: 20,
            minimum: 1,
          }),
          option(
            "textMax",
            "--text-max <n>",
            "Maximum text characters per result.",
            { type: "int", default: 120, minimum: 1 },
          ),
        ],
      },
    ),
    protocol(
      "frames",
      "List iframe frame-tree entries for the selected browser renderer.",
      "list",
    ),
    protocol(
      "downloads",
      "List recent provider-owned browser download records without exposing local paths.",
      "list",
      {
        args: [
          option(
            "limit",
            "--limit <n>",
            "Maximum download records to return.",
            { type: "int", default: 20, minimum: 1 },
          ),
        ],
      },
    ),
    semantic(
      "extract",
      "Extract bounded long-form rendered text, optionally writing render-aware screenshot evidence.",
      "get",
      {
        effect: "download_file",
        idempotency: "none",
        actuation: "screen-capture",
        interactionImpact: "background",
        args: [
          option(
            "selector",
            "--selector <css>",
            "Optional CSS selector for the content root.",
            { type: "str", "x-unicli-kind": "selector" },
          ),
          option(
            "chunkSize",
            "--chunk-size <n>",
            "Maximum text characters to return.",
            { type: "int", default: 8000, minimum: 256 },
          ),
          option("start", "--start <n>", "Text offset to start from.", {
            type: "int",
            default: 0,
            minimum: 0,
          }),
          ...renderAwareArgs(),
        ],
      },
    ),
    protocol(
      "tabs",
      "List open tabs in the selected browser workspace without focusing them.",
      "list",
    ),
    protocol(
      "search",
      "Search bounded content across eligible open browser tabs and optional history without navigation.",
      "search",
      {
        args: [
          positional("query", "Text to search for across browser content.", {
            type: "str",
            required: true,
            minLength: 1,
          }),
          option(
            "history",
            "--history",
            "Also search Chrome history metadata.",
            { type: "bool" },
          ),
          option("from", "--from <time>", "History start time.", {
            type: "str",
          }),
          option("to", "--to <time>", "History end time.", { type: "str" }),
          option("maxResults", "--max-results <n>", "Maximum merged results.", {
            type: "int",
            minimum: 1,
            maximum: 100,
          }),
          option(
            "maxTabs",
            "--max-tabs <n>",
            "Maximum recent open tabs to scan.",
            { type: "int", minimum: 1, maximum: 200 },
          ),
          option(
            "maxCharsPerTab",
            "--max-chars-per-tab <n>",
            "Maximum DOM text characters scanned per tab.",
            { type: "int", minimum: 1024, maximum: 500000 },
          ),
        ],
      },
    ),
    protocol(
      "network",
      "Read captured network request metadata and maintain the renderer workspace cache used for bounded body detail reads.",
      "list",
      {
        effect: "local_file",
        idempotency: "conditional",
        args: [
          positional("pattern", "Optional URL substring filter.", {
            type: "str",
          }),
          option("all", "--all", "Return all captured requests.", {
            type: "bool",
          }),
          option("raw", "--raw", "Include response bodies when available.", {
            type: "bool",
          }),
          option(
            "detail",
            "--detail <key>",
            "Read the cached full body for one network entry.",
            { type: "str" },
          ),
          option(
            "filter",
            "--filter <fields>",
            "Comma-separated body field names that must all exist.",
            { type: "str" },
          ),
          option(
            "maxBody",
            "--max-body <chars>",
            "Maximum body characters emitted for a detail read; zero is unlimited.",
            { type: "int", default: 0, minimum: 0 },
          ),
          option("ttl", "--ttl <ms>", "Network cache TTL in milliseconds.", {
            type: "int",
            default: 86400000,
            minimum: 1,
          }),
        ],
      },
    ),
    semantic(
      "analyze",
      "Navigate to and analyze one website for structured adapter authoring signals.",
      "get",
      {
        args: [
          positional("url", "Absolute URL to analyze.", {
            type: "str",
            required: true,
            format: "uri",
          }),
        ],
      },
    ),
  ] satisfies readonly BrowserOperationSpec[]);

const BROWSER_OPERATION_BY_COMMAND = new Map(
  BROWSER_OPERATION_SPECS.map((spec) => [spec.command, spec]),
);

export function getBrowserOperationSpec(
  command: string,
): BrowserOperationSpec | undefined {
  return BROWSER_OPERATION_BY_COMMAND.get(command);
}

export function browserOperationShell(spec: BrowserOperationSpec): string {
  const args = spec.args.map((arg) => {
    if (arg.positional) {
      return arg.required ? `<${arg.name}>` : `[${arg.name}]`;
    }
    const flags = arg.flags ?? `--${arg.name}`;
    return arg.required ? flags : `[${flags}]`;
  });
  return [`unicli browser ${spec.command}`, ...args].join(" ").trim();
}
