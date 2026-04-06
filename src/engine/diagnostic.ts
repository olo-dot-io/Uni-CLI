/**
 * RepairContext Diagnostic Module — structured error context for agent self-repair.
 *
 * When UNICLI_DIAGNOSTIC=1, pipeline failures emit a RepairContext JSON block
 * to stderr, giving agents everything they need to diagnose and fix the adapter:
 *   - Error details with hints
 *   - Full adapter source (YAML/TS)
 *   - Browser page state (URL, DOM snapshot, network, console errors)
 */

import { readFileSync } from "node:fs";
import { ExitCode } from "../types.js";
import type { BrowserPage } from "../browser/page.js";

export interface RepairContext {
  error: {
    code: string;
    message: string;
    hint?: string;
    stack?: string;
  };
  adapter: {
    site: string;
    command: string;
    sourcePath?: string;
    source?: string;
  };
  page?: {
    url: string;
    snapshot: string;
    networkRequests: Array<{
      url: string;
      method: string;
      status: number;
      type: string;
    }>;
    consoleErrors: string[];
  };
  timestamp: string;
}

/** Map ExitCode numeric values to their symbolic names. */
const EXIT_CODE_NAMES: Record<number, string> = {};
for (const [name, code] of Object.entries(ExitCode)) {
  EXIT_CODE_NAMES[code] = name;
}

/**
 * Resolve a human-readable error code name from an Error instance.
 * PipelineError has errorType; generic errors map to GENERIC_ERROR.
 */
function resolveErrorCode(err: Error): string {
  // PipelineError carries a detail.errorType
  if ("detail" in err) {
    const detail = (err as { detail?: { errorType?: string } }).detail;
    if (detail?.errorType) return detail.errorType.toUpperCase();
  }
  return EXIT_CODE_NAMES[ExitCode.GENERIC_ERROR] ?? "GENERIC_ERROR";
}

/**
 * Build a RepairContext from a pipeline error and execution context.
 */
export async function buildRepairContext(opts: {
  error: Error;
  site: string;
  command: string;
  adapterPath?: string;
  page?: BrowserPage;
}): Promise<RepairContext> {
  const { error, site, command, adapterPath, page } = opts;

  // 1. Error section
  const hint =
    "detail" in error
      ? ((error as { detail?: { errorType?: string } }).detail?.errorType ??
        undefined)
      : undefined;

  const errorSection: RepairContext["error"] = {
    code: resolveErrorCode(error),
    message: error.message,
    hint,
    stack: error.stack,
  };

  // 2. Adapter section
  const adapterSection: RepairContext["adapter"] = {
    site,
    command,
    sourcePath: adapterPath,
  };

  if (adapterPath) {
    try {
      adapterSection.source = readFileSync(adapterPath, "utf-8");
    } catch {
      // File may not exist or be unreadable
    }
  }

  // 3. Page diagnostics (only when UNICLI_DIAGNOSTIC=1 and page is available)
  let pageSection: RepairContext["page"] | undefined;
  if (page && process.env.UNICLI_DIAGNOSTIC === "1") {
    try {
      const [url, snapshot, networkRequests, consoleRaw] = await Promise.all([
        page.url(),
        page.snapshot({ compact: true }).catch(() => "(snapshot unavailable)"),
        page
          .networkRequests()
          .then((reqs) =>
            reqs.map((r) => ({
              url: r.url,
              method: r.method,
              status: r.status,
              type: r.type,
            })),
          )
          .catch(
            () =>
              [] as Array<{
                url: string;
                method: string;
                status: number;
                type: string;
              }>,
          ),
        page
          .evaluate("JSON.stringify(window.__unicli_console_errors || [])")
          .catch(() => "[]"),
      ]);

      let consoleErrors: string[] = [];
      try {
        consoleErrors = JSON.parse(String(consoleRaw)) as string[];
      } catch {
        // Ignore parse failure
      }

      pageSection = { url, snapshot, networkRequests, consoleErrors };
    } catch {
      // Page diagnostics are best-effort
    }
  }

  return {
    error: errorSection,
    adapter: adapterSection,
    page: pageSection,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Emit RepairContext to stderr wrapped in markers for machine parsing.
 */
export function emitRepairContext(ctx: RepairContext): void {
  const marker = "___UNICLI_DIAGNOSTIC___";
  process.stderr.write(
    `\n${marker}\n${JSON.stringify(ctx, null, 2)}\n${marker}\n`,
  );
}
