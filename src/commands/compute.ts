import { Command } from "commander";

import { getBus } from "../transport/bus.js";
import { tryCascade } from "../transport/cascade.js";
import { loadCdpSession, saveCdpSession } from "../transport/cdp-session.js";
import { loadRefStore, saveRefStore } from "../transport/refs.js";
import { captureComputeContext } from "../compute/capture.js";
import {
  copyReferenceMarkupToClipboard,
  saveComputeCaptureReference,
} from "../compute/capture-reference.js";
import { err, exitCodeFor } from "../core/envelope.js";
import type { ActionResult } from "../transport/types.js";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";

export function registerComputeCommand(program: Command): void {
  const compute = program
    .command("compute")
    .description(
      "Operate installed apps through native accessibility, CDP, and visual fallback transports",
    );

  compute
    .command("apps")
    .description("List running apps")
    .action(async () => {
      await run(program, "compute.apps", "compute_apps", {});
    });

  compute
    .command("windows")
    .description("List app windows")
    .option("--app <name>", "Filter by app")
    .action(async (opts: Record<string, unknown>) => {
      await run(program, "compute.windows", "compute_windows", opts);
    });

  compute
    .command("snapshot")
    .description("Capture a compact accessibility snapshot")
    .option("--app <name>", "Target app")
    .option("--format <fmt>", "compact | tree | json", "compact")
    .option("--interactive-only", "Only include interactive elements")
    .option("--max-depth <n>", "Maximum tree depth", "64")
    .action(async (opts: Record<string, unknown>) => {
      const snapshotFormat = readSnapshotFormat(
        program,
        opts.format,
        "snapshot",
      );
      if (!snapshotFormat.ok) {
        print(
          program,
          "compute.snapshot",
          Date.now(),
          invalidOptionResult(
            "compute_snapshot",
            `invalid snapshot format: ${snapshotFormat.value}`,
            "use --format compact, tree, or json",
            "compute.snapshot",
          ),
        );
        return;
      }
      await run(program, "compute.snapshot", "compute_snapshot", {
        ...opts,
        format: snapshotFormat.value,
        maxDepth: parseInt(String(opts.maxDepth ?? "64"), 10),
      });
    });

  compute
    .command("capture")
    .description("Capture a reusable app context packet")
    .option("--app <name>", "Target app")
    .option("--format <fmt>", "compact | tree | json", "compact")
    .option("--include <parts>", "snapshot,screenshot", "snapshot,screenshot")
    .option("--max-depth <n>", "Maximum snapshot tree depth", "64")
    .option("--screenshot-path <path>", "Optional screenshot output path")
    .option("--save-reference", "Persist an app-shots reference for handoff")
    .option("--copy-reference", "Persist and copy the app-shots reference")
    .option("--reference-root <dir>", "Directory for saved app-shots artifacts")
    .action(async (opts: Record<string, unknown>) => {
      await runCapture(program, opts);
    });

  compute
    .command("find")
    .description("Find matching elements in the latest snapshot")
    .requiredOption("--role <role>", "button | input | menuitem | ...")
    .option("--name <name>", "Substring match")
    .option("--text <text>", "Match visible/current text value")
    .option("--app <app>", "Target app")
    .option("--first", "Return the first match")
    .action(async (opts: Record<string, unknown>) => {
      await run(program, "compute.find", "compute_find", opts);
    });

  compute
    .command("click <ref>")
    .description("Click an element ref")
    .option("--background", "Avoid focusing the target app")
    .option("--focus", "Focus the target app first")
    .action(async (ref: string, opts: Record<string, unknown>) => {
      await run(program, "compute.click", "compute_click", {
        ref,
        ...normalizeFocusOptions(opts),
      });
    });

  compute
    .command("type <ref> <text>")
    .description("Set or type text into an element ref")
    .option("--clear", "Clear field first")
    .option("--focus", "Focus the target app first")
    .action(
      async (ref: string, text: string, opts: Record<string, unknown>) => {
        await run(program, "compute.type", "compute_type", {
          ref,
          text,
          ...normalizeFocusOptions(opts),
        });
      },
    );

  compute
    .command("press <combo>")
    .description("Press a key combo, e.g. cmd+s or ctrl+shift+p")
    .option("--app <app>", "Target app")
    .option("--focus", "Focus the target app first")
    .action(async (combo: string, opts: Record<string, unknown>) => {
      await run(program, "compute.press", "compute_press", {
        combo,
        ...normalizeFocusOptions(opts),
      });
    });

  compute
    .command("scroll <ref>")
    .description("Scroll an element ref")
    .option("--direction <direction>", "up | down | left | right", "down")
    .option("--amount <px>", "Pixels", "300")
    .option("--focus", "Focus the target app first")
    .action(async (ref: string, opts: Record<string, unknown>) => {
      const normalized = normalizeFocusOptions(opts);
      await run(program, "compute.scroll", "compute_scroll", {
        ref,
        ...normalized,
        amount: parseInt(String(normalized.amount ?? "300"), 10),
      });
    });

  compute
    .command("launch <app>")
    .description("Launch an app")
    .option("--debug-port <port>", "Electron CDP debug port")
    .action(async (app: string, opts: Record<string, unknown>) => {
      await run(program, "compute.launch", "compute_launch", {
        app,
        ...opts,
        ...(opts.debugPort !== undefined
          ? { debugPort: parseInt(String(opts.debugPort), 10) }
          : {}),
      });
    });

  compute
    .command("screenshot [path]")
    .description("Capture a screenshot")
    .option("--app <app>", "Target app")
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      await run(program, "compute.screenshot", "compute_screenshot", {
        path,
        ...opts,
      });
    });

  compute
    .command("attach")
    .description("Attach CDP to an Electron app")
    .option("--app <name>", "Bundle id or app name")
    .option("--port <port>", "CDP port")
    .option(
      "--confirm-relaunch",
      "Allow relaunching apps that may lose session state",
    )
    .action(async (opts: Record<string, unknown>) => {
      await run(program, "compute.attach", "compute_cdp_attach", {
        ...opts,
        ...(opts.port !== undefined
          ? { port: parseInt(String(opts.port), 10) }
          : {}),
      });
    });

  compute
    .command("eval <js>")
    .description("Evaluate JS in the attached CDP renderer")
    .action(async (js: string) => {
      await run(program, "compute.eval", "compute_evaluate", { script: js });
    });

  compute
    .command("wait")
    .description("Wait for a ref, text, or state")
    .option("--ref <ref>", "Element ref")
    .option("--text <text>", "Text to wait for")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .action(async (opts: Record<string, unknown>) => {
      await run(program, "compute.wait", "compute_wait", {
        ...opts,
        timeout: parseInt(String(opts.timeout ?? "10000"), 10),
      });
    });

  compute
    .command("observe <goal>")
    .description("Rank candidate refs for a natural-language goal")
    .action(async (goal: string) => {
      await run(program, "compute.observe", "compute_observe", { goal });
    });

  compute
    .command("assert")
    .description("Assert text, ref, or state")
    .option("--ref <ref>", "Element ref")
    .option("--text <text>", "Expected text")
    .option("--state <state>", "enabled | focused | checked")
    .action(async (opts: Record<string, unknown>) => {
      await run(program, "compute.assert", "compute_assert", opts);
    });
}

async function run(
  program: Command,
  command: string,
  kind: string,
  params: Record<string, unknown>,
): Promise<void> {
  const startedAt = Date.now();
  const bus = getBus();
  try {
    loadPersistedRefs(bus);
    const dispatchParams = enrichWithPersistedCdpSession(kind, params);
    const result = await tryCascade(bus, { kind, params: dispatchParams });
    if (result.ok && kind === "compute_snapshot") {
      saveRefStore(bus.refs);
    }
    if (result.ok && kind === "compute_cdp_attach") {
      persistCdpAttach(result.data);
    }
    print(program, command, startedAt, result);
  } finally {
    await closeTransports(bus);
  }
}

async function runCapture(
  program: Command,
  opts: Record<string, unknown>,
): Promise<void> {
  const startedAt = Date.now();
  const bus = getBus();
  try {
    loadPersistedRefs(bus);
    const app = typeof opts.app === "string" ? opts.app : undefined;
    const snapshotFormat = readSnapshotFormat(program, opts.format, "capture");
    if (!snapshotFormat.ok) {
      print(
        program,
        "compute.capture",
        startedAt,
        invalidOptionResult(
          "compute_capture",
          `invalid snapshot format: ${snapshotFormat.value}`,
          "use --format compact, tree, or json",
          "compute.capture",
        ),
      );
      return;
    }
    const maxDepth = parseInt(String(opts.maxDepth ?? "64"), 10);
    const screenshotPath =
      typeof opts.screenshotPath === "string" && opts.screenshotPath
        ? opts.screenshotPath
        : undefined;
    const result = await captureComputeContext(
      bus,
      {
        ...(app ? { app } : {}),
        ...(typeof opts.include === "string" ? { include: opts.include } : {}),
        format: snapshotFormat.value,
        maxDepth,
        ...(screenshotPath ? { screenshotPath } : {}),
      },
      { onSnapshotSuccess: () => saveRefStore(bus.refs) },
    );
    const shouldSaveReference =
      opts.saveReference === true || opts.copyReference === true;
    let printableResult: ActionResult<unknown> = result;
    if (result.ok && shouldSaveReference) {
      const referenceRoot =
        typeof opts.referenceRoot === "string" && opts.referenceRoot
          ? opts.referenceRoot
          : undefined;
      const reference = await saveComputeCaptureReference(
        result.data,
        referenceRoot ? { rootDir: referenceRoot } : {},
      );
      if (opts.copyReference === true) {
        try {
          await copyReferenceMarkupToClipboard(reference.markup);
        } catch (error) {
          printableResult = err({
            transport: "subprocess",
            step: 0,
            action: "compute_capture.copy_reference",
            reason: errorMessage(error),
            suggestion:
              "inspect the clipboard command or rerun with --save-reference",
            minimum_capability: "compute.capture.copy-reference",
            exit_code: exitCodeFor("service_unavailable"),
          });
          print(program, "compute.capture", startedAt, printableResult);
          return;
        }
      }
      printableResult = {
        ...result,
        data: {
          ...result.data,
          reference: {
            ...reference,
            ...(opts.copyReference === true ? { clipboard: { ok: true } } : {}),
          },
        },
      };
    }

    print(program, "compute.capture", startedAt, printableResult);
  } finally {
    await closeTransports(bus);
  }
}

function loadPersistedRefs(bus: ReturnType<typeof getBus>): void {
  const loaded = loadRefStore();
  bus.refs.clear();
  for (const bucket of loaded.buckets()) {
    bus.refs.put(bucket);
  }
}

function enrichWithPersistedCdpSession(
  kind: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!CDP_SESSION_STEPS.has(kind)) return params;
  if (typeof params.port === "number") return params;
  const session = loadCdpSession();
  if (!session) return params;
  return {
    ...params,
    ...(session.app ? { app: session.app } : {}),
    port: session.port,
    webSocketDebuggerUrl: session.webSocketDebuggerUrl,
  };
}

function persistCdpAttach(data: unknown): void {
  if (!isRecord(data)) return;
  const port = data.port;
  const webSocketDebuggerUrl = data.webSocketDebuggerUrl;
  const app = data.app;
  if (
    typeof port !== "number" ||
    !Number.isFinite(port) ||
    typeof webSocketDebuggerUrl !== "string" ||
    !webSocketDebuggerUrl
  ) {
    return;
  }
  saveCdpSession({
    port,
    webSocketDebuggerUrl,
    ...(typeof app === "string" && app ? { app } : {}),
  });
}

async function closeTransports(bus: ReturnType<typeof getBus>): Promise<void> {
  await Promise.allSettled(bus.list().map((adapter) => adapter.close()));
}

const CDP_SESSION_STEPS = new Set([
  "compute_evaluate",
  "compute_snapshot",
  "compute_screenshot",
  "compute_click",
  "compute_type",
  "compute_press",
  "compute_scroll",
  "compute_wait",
]);

function print(
  program: Command,
  command: string,
  startedAt: number,
  result: ActionResult<unknown>,
): void {
  const fmt = detectFormat(readRootFormat(program));
  if (result.ok) {
    console.log(
      format(
        formatData(result.data),
        undefined,
        fmt,
        makeCtx(command, startedAt, { surface: "desktop" }),
      ),
    );
    return;
  }

  process.exitCode = result.error.exit_code;
  console.error(
    format(null, undefined, fmt, {
      ...makeCtx(command, startedAt, { surface: "desktop" }),
      error: {
        code: "compute_failed",
        message: result.error.reason,
        step: result.error.step,
        suggestion: result.error.suggestion,
        remedy: result.error.remedy,
        retryable: result.error.retryable,
      },
    }),
  );
}

function formatData(data: unknown): unknown[] | Record<string, unknown> {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return data as Record<string, unknown>;
  return { value: data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidOptionResult(
  action: string,
  reason: string,
  suggestion: string,
  minimumCapability: string,
): ActionResult<never> {
  return err({
    transport: "subprocess",
    step: 0,
    action,
    reason,
    suggestion,
    minimum_capability: minimumCapability,
    exit_code: exitCodeFor("usage_error"),
  });
}

function normalizeFocusOptions(
  opts: Record<string, unknown>,
): Record<string, unknown> {
  const { background: _background, focus, ...rest } = opts;
  return { ...rest, focus: focus === true };
}

function readRootFormat(program: Command): OutputFormat | undefined {
  const args =
    (program as Command & { rawArgs?: readonly string[] }).rawArgs ?? [];
  const commandIndex = args.indexOf("compute");
  const end = commandIndex >= 0 ? commandIndex : args.length;
  for (let i = 0; i < end; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue;
    if (arg === "-f" || arg === "--format") {
      const value = args[i + 1];
      return isOutputFormat(value) ? value : undefined;
    }
    if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      return isOutputFormat(value) ? value : undefined;
    }
  }
  return undefined;
}

function readSnapshotFormat(
  program: Command,
  fallback: unknown,
  subcommand: "snapshot" | "capture",
):
  | { ok: true; value: "compact" | "tree" | "json" }
  | { ok: false; value: string } {
  const args =
    (program as Command & { rawArgs?: readonly string[] }).rawArgs ?? [];
  const subcommandIndex = args.indexOf(subcommand);
  if (subcommandIndex >= 0) {
    for (let i = subcommandIndex + 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--format") {
        const value = args[i + 1];
        return isSnapshotFormat(value)
          ? { ok: true, value }
          : { ok: false, value: String(value ?? "") };
      }
      if (arg.startsWith("--format=")) {
        const value = arg.slice("--format=".length);
        return isSnapshotFormat(value)
          ? { ok: true, value }
          : { ok: false, value };
      }
    }
  }
  if (fallback === undefined) return { ok: true, value: "compact" };
  return isSnapshotFormat(fallback)
    ? { ok: true, value: fallback }
    : { ok: false, value: String(fallback) };
}

function isSnapshotFormat(
  value: unknown,
): value is "compact" | "tree" | "json" {
  return value === "compact" || value === "tree" || value === "json";
}

function isOutputFormat(value: string | undefined): value is OutputFormat {
  return (
    value === "md" ||
    value === "json" ||
    value === "yaml" ||
    value === "csv" ||
    value === "compact" ||
    value === "table"
  );
}
