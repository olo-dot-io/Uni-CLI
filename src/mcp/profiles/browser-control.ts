/**
 * @owner       src::mcp::profiles::browser-control
 * @does        Compose strict direct MCP tools for Chrome discovery/search/presence and prepared-target state, navigation, and atomic ref actions.
 * @needs       BrowserBridge, browser-capability/input modules, ambient invocation scope, browser operator permission boundary, MCP tool contracts
 * @feeds       src/mcp/tools.ts computer-use profile
 * @breaks      Invalid input, missing preparation/capability, permission denial, provider failure, or lifecycle failure returns a structured MCP error without fallback.
 * @invariants  Input, permission, provider/visibility admission, and cancellation checks complete before broker acquisition; navigate/actions never launch implicitly; search allocates no target; Chrome mutations claim the explicit tab; a late abort cannot overwrite authoritative provider success or ambiguity; ambient policy is never overridden.
 * @side-effects May prepare, read, navigate, or actuate an exact browser target; search remains read-only and target-free; foreground presence is explicit.
 * @perf        One broker session handshake per call; state and atomic ref actions use one renderer/provider round trip each; every discovery/search/state output is bounded.
 * @concurrency MCP cancellation flows through the ambient scope while the broker serializes snapshot capability verification and mutation on one target queue.
 * @test        tests/unit/mcp/browser-control.test.ts, tests/unit/mcp/tools.test.ts, tests/unit/mcp-server.test.ts
 * @stability   experimental
 * @since       2026-07-16
 */

import { BrowserBridge, type BrowserBrokerPage } from "../../browser/bridge.js";
import {
  currentBrowserInvocationScope,
  type BrowserInvocationScope,
} from "../../browser/invocation-scope.js";
import { type ChromeContentSearchQuery } from "../../browser/chrome-native-protocol.js";
import { authorizeBrowserOperator } from "../../commands/browser/permission.js";
import type { McpToolResult } from "../dispatch.js";
import type { McpTool, McpToolExecutionContext } from "../tools.js";
import {
  captureBrowserScreenshot,
  clickBrowserTarget,
  navigateBrowserTarget,
  prepareBrowserTarget,
  pressBrowserKey,
  readBrowserDialogs,
  readBrowserDownloads,
  readBrowserState,
  respondBrowserDialog,
  scrollBrowserTarget,
  typeBrowserRef,
  type BrowserControlImageResult,
} from "./browser-capability.js";
import {
  BROWSER_CONTROL_INPUT as INPUT,
  type BrowserControlParams as Params,
} from "./browser-control-input.js";

interface BrowserControlDefinition {
  suffix: string;
  description: string;
  permissionAction: string;
  readOnly: boolean;
  destructive?: boolean;
  scopeRequirement: "any" | "chrome" | "chrome_foreground";
  inputSchema: McpTool["inputSchema"];
  parse(args: Params): Params;
  execute(
    page: BrowserBrokerPage,
    args: Params,
    scope: BrowserInvocationScope,
  ): Promise<unknown>;
}

const DEFINITIONS: readonly BrowserControlDefinition[] = [
  {
    suffix: "browser_tabs",
    description:
      "List normal Chrome tabs without activating them. Requires MCP startup with --browser-provider chrome.",
    permissionAction: "tabs",
    readOnly: true,
    scopeRequirement: "chrome",
    ...INPUT.empty,
    execute: (page) => page.tabs(),
  },
  {
    suffix: "browser_prepare",
    description:
      "Explicitly prepare one broker-owned target. Chrome creates an inactive owned tab without claiming a user tab; managed startup follows the configured owned automation-profile seeding policy; remote uses the configured endpoint.",
    permissionAction: "prepare",
    readOnly: false,
    destructive: true,
    scopeRequirement: "any",
    ...INPUT.empty,
    execute: prepareBrowserTarget,
  },
  {
    suffix: "browser_state",
    description:
      "Read-only snapshot of up to max_refs actionable elements with snapshot-scoped refs across the main document, open shadow roots, and same-origin frames. Managed/remote targets require browser_prepare; Chrome requires an explicit tab_id.",
    permissionAction: "state",
    readOnly: true,
    scopeRequirement: "any",
    ...INPUT.state,
    execute: readBrowserState,
  },
  {
    suffix: "browser_screenshot",
    description:
      "Capture a bounded screenshot from the exact prepared target or explicit Chrome tab and return it as an MCP image without writing a file.",
    permissionAction: "screenshot",
    readOnly: true,
    scopeRequirement: "any",
    ...INPUT.screenshot,
    execute: captureBrowserScreenshot,
  },
  {
    suffix: "browser_navigate",
    description:
      "Navigate the exact broker-owned target or explicitly claimed Chrome tab without provider fallback, then return final target identity.",
    permissionAction: "navigate",
    readOnly: false,
    scopeRequirement: "any",
    ...INPUT.navigate,
    execute: navigateBrowserTarget,
  },
  {
    suffix: "browser_click",
    description:
      "Click one ref from the latest browser_state or one explicit viewport point through the trusted CDP input route. Stale snapshots, shadow/frame mismatch, and missing targets refuse without synthetic fallback.",
    permissionAction: "click",
    readOnly: false,
    scopeRequirement: "any",
    ...INPUT.click,
    execute: clickBrowserTarget,
  },
  {
    suffix: "browser_type",
    description:
      "Type into one editable ref from the latest browser_state using bounded bulk insertion or per-character key events on the exact target.",
    permissionAction: "type",
    readOnly: false,
    scopeRequirement: "any",
    ...INPUT.type,
    execute: typeBrowserRef,
  },
  {
    suffix: "browser_press",
    description:
      "Dispatch one exact browser key pair with optional bounded modifiers to the prepared target or explicit Chrome tab.",
    permissionAction: "press",
    readOnly: false,
    scopeRequirement: "any",
    ...INPUT.key,
    execute: pressBrowserKey,
  },
  {
    suffix: "browser_scroll",
    description:
      "Scroll the exact page viewport up, down, to top, or to bottom without changing tabs or providers.",
    permissionAction: "scroll",
    readOnly: false,
    scopeRequirement: "any",
    ...INPUT.scroll,
    execute: scrollBrowserTarget,
  },
  {
    suffix: "browser_search",
    description:
      "Search bounded text in open Chrome pages and optional history without focus, navigation, or debugger attachment. Requires --browser-provider chrome.",
    permissionAction: "search",
    readOnly: true,
    scopeRequirement: "chrome",
    ...INPUT.search,
    execute: (page, args) =>
      page.searchChromeContent(args as unknown as ChromeContentSearchQuery),
  },
  {
    suffix: "browser_claim",
    description:
      "Claim one explicit Chrome tab for the current Agent session without taking ownership of the user's tab. Visibility follows MCP startup policy.",
    permissionAction: "claim",
    readOnly: false,
    scopeRequirement: "chrome",
    ...INPUT.tab,
    execute: (page, args) => page.claimChromeTab(args.tab_id as number),
  },
  {
    suffix: "browser_dialogs",
    description:
      "Read bounded pending and recent JavaScript-dialog state for one explicit Chrome tab without responding to it.",
    permissionAction: "dialogs",
    readOnly: true,
    scopeRequirement: "chrome",
    ...INPUT.tab,
    execute: readBrowserDialogs,
  },
  {
    suffix: "browser_dialog",
    description:
      "Accept or dismiss one selected pending JavaScript dialog on an explicit Chrome tab; multiple dialogs require dialog_id.",
    permissionAction: "dialog",
    readOnly: false,
    scopeRequirement: "chrome",
    ...INPUT.dialog,
    execute: respondBrowserDialog,
  },
  {
    suffix: "browser_downloads",
    description:
      "Read bounded recent Chrome download metadata without exposing local directory paths.",
    permissionAction: "downloads",
    readOnly: true,
    scopeRequirement: "chrome",
    ...INPUT.downloads,
    execute: readBrowserDownloads,
  },
  {
    suffix: "browser_presence",
    description:
      "Show or remove the isolated edge frame on one explicit Chrome tab. Requires --browser-provider chrome --browser-visibility foreground.",
    permissionAction: "agent presence",
    readOnly: false,
    scopeRequirement: "chrome_foreground",
    ...INPUT.presence,
    execute: async (page, args) => {
      await page.claimChromeTab(args.tab_id as number);
      return page.setAgentPresence(
        args.visible as boolean,
        args.label as string | undefined,
      );
    },
  },
  {
    suffix: "browser_cursor",
    description:
      "Move the pointer-through virtual cursor in current CSS-pixel coordinates on one explicit foreground Chrome tab.",
    permissionAction: "agent cursor",
    readOnly: false,
    scopeRequirement: "chrome_foreground",
    ...INPUT.cursor,
    execute: async (page, args) => {
      await page.claimChromeTab(args.tab_id as number);
      return page.moveAgentCursor(
        args.x as number,
        args.y as number,
        args.visible as boolean,
      );
    },
  },
];

export const BROWSER_CONTROL_TOOLS: McpTool[] = DEFINITIONS.map(
  (definition) => ({
    name: `computer-use.${definition.suffix}`,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: {
      readOnlyHint: definition.readOnly,
      destructiveHint: definition.destructive ?? false,
      idempotentHint: definition.readOnly,
      openWorldHint: true,
    },
    execution: {
      taskSupport: definition.readOnly ? "optional" : "required",
    },
    handler: (args, context) =>
      executeBrowserControlTool(definition, args, context),
  }),
);

async function executeBrowserControlTool(
  definition: BrowserControlDefinition,
  rawArgs: Params,
  context?: McpToolExecutionContext,
): Promise<McpToolResult> {
  context?.signal?.throwIfAborted();
  try {
    const args = definition.parse(rawArgs);
    const scope = requireBrowserScope(definition.scopeRequirement);
    await authorizeBrowserOperator("browser", definition.permissionAction, {
      argumentValues: {
        ...args,
        provider: scope.provider,
        visibility: scope.visibility,
        profilePartitionId: scope.profilePartitionId,
      },
    });
    context?.signal?.throwIfAborted();
    const page = (await new BrowserBridge().connect()) as BrowserBrokerPage;
    const data = await definition.execute(page, args, scope);
    return browserControlResult(definition, scope, true, data);
  } catch (error) {
    if (context?.signal?.aborted && error === context.signal.reason)
      throw error;
    const scope = currentBrowserInvocationScope();
    return browserControlResult(
      definition,
      scope,
      false,
      structuredBrowserError(error),
    );
  }
}

function requireBrowserScope(
  requirement: BrowserControlDefinition["scopeRequirement"],
): BrowserInvocationScope {
  const scope = currentBrowserInvocationScope();
  if (!scope) {
    throw new BrowserControlCapabilityError(
      "Browser MCP tools require a transport-owned invocation scope",
      "Invoke the tool through the Uni-CLI MCP server instead of calling its handler directly.",
    );
  }
  if (
    (requirement === "chrome" || requirement === "chrome_foreground") &&
    scope.provider !== "chrome"
  ) {
    throw new BrowserControlCapabilityError(
      `Browser MCP tool requires Chrome, but the server selected ${scope.provider}`,
      "Restart MCP with --browser-provider chrome --browser-visibility background, or foreground for page presence.",
    );
  }
  if (
    requirement === "chrome_foreground" &&
    scope.visibility !== "foreground"
  ) {
    throw new BrowserControlCapabilityError(
      `Browser page presence requires foreground visibility, but the server selected ${scope.visibility}`,
      "Restart MCP with --browser-provider chrome --browser-visibility foreground.",
    );
  }
  return scope;
}

class BrowserControlCapabilityError extends Error {
  readonly code = "browser_provider_capability_unavailable";
  readonly retryable = false;
  readonly exitCode = 69;

  constructor(
    message: string,
    readonly suggestion: string,
  ) {
    super(message);
    this.name = "BrowserControlCapabilityError";
  }
}

function browserControlResult(
  definition: BrowserControlDefinition,
  scope: BrowserInvocationScope | undefined,
  ok: boolean,
  data: unknown,
): McpToolResult {
  const tool = `computer-use.${definition.suffix}`;
  const image = readBrowserControlImage(data);
  const resultData = image ? withoutBrowserControlImage(data) : data;
  const payload = ok
    ? { ok: true, operation: definition.suffix, data: resultData }
    : { ok: false, operation: definition.suffix, error: resultData };
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
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: { type: "json", data: payload },
    _meta: {
      evidence: {
        evidence_type: "computer-use-browser",
        tool,
        operation: definition.suffix,
        ok,
        provider: scope?.provider ?? "unavailable",
        visibility: scope?.visibility ?? "unavailable",
      },
    },
    ...(ok ? {} : { isError: true }),
  };
}

function readBrowserControlImage(
  value: unknown,
): BrowserControlImageResult["image"] | undefined {
  if (!isRecord(value) || !isRecord(value.image)) return undefined;
  return typeof value.image.data === "string" &&
    typeof value.image.mimeType === "string" &&
    value.image.mimeType.startsWith("image/")
    ? { data: value.image.data, mimeType: value.image.mimeType }
    : undefined;
}

function withoutBrowserControlImage(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { image: _image, ...rest } = value;
  return rest;
}

function structuredBrowserError(error: unknown): Record<string, unknown> {
  const record = isRecord(error) ? error : {};
  const code =
    typeof record.code === "string" ? record.code : "browser_control_failed";
  const suggestion =
    typeof record.suggestion === "string"
      ? record.suggestion
      : "Run `unicli browser doctor --json`, repair the reported boundary, and retry.";
  const exitCode =
    typeof record.exitCode === "number"
      ? record.exitCode
      : typeof record.exit_code === "number"
        ? record.exit_code
        : 1;
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    suggestion,
    retryable: record.retryable === true,
    exit_code: exitCode,
    ...(record.outcome_ambiguous === true ? { outcome_ambiguous: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
