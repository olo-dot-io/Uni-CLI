/**
 * Five-category live capability smoke.
 *
 * This exercises execution structure rather than collecting benchmark data:
 * structured web, native CLI, browser semantics, desktop accessibility, and
 * explicit coordinate OS driver. Optional providers are reported as skipped;
 * an available provider that violates its contract fails.
 */

import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runContainedProcess } from "../src/transport/contained-process.js";

type SmokeStatus = "pass" | "fail" | "skip";

interface SmokeResult {
  category:
    | "structured-web"
    | "native-cli"
    | "browser-semantic"
    | "desktop-accessibility"
    | "coordinate-driver";
  operator:
    | "structured-api"
    | "native-cli"
    | "browser-semantic"
    | "desktop-accessibility"
    | "visual-coordinate";
  status: SmokeStatus;
  assertion: string;
  elapsed_ms: number;
  detail: string;
}

interface CommandResult {
  value: unknown;
  elapsedMs: number;
}

const root = process.cwd();
const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
const unicliSource = resolve(root, "src/main.ts");

await access(tsxCli);
await access(unicliSource);

const results: SmokeResult[] = [];
results.push(await smokeStructuredWeb());
results.push(await smokeNativeCli());
results.push(await smokeBrowserSemantic());
results.push(await smokeDesktopAccessibility());
results.push(await smokeCoordinateDriver());

const failed = results.filter((result) => result.status === "fail");
console.log(
  JSON.stringify(
    {
      schema_version: "capability-live-smoke.v1",
      status: failed.length === 0 ? "ok" : "failed",
      summary: {
        pass: results.filter((result) => result.status === "pass").length,
        skip: results.filter((result) => result.status === "skip").length,
        fail: failed.length,
      },
      results,
    },
    null,
    2,
  ),
);
if (failed.length > 0) process.exitCode = 1;

async function smokeStructuredWeb(): Promise<SmokeResult> {
  return executeSmoke(
    "structured-web",
    "structured-api",
    "public adapter returns a structured envelope without browser or desktop control",
    async () => {
      const result = await unicli(["hackernews", "top", "--limit", "1"]);
      assertEnvelopeOk(result.value);
      return {
        elapsedMs: result.elapsedMs,
        detail:
          "hackernews/top completed through its declared structured adapter",
      };
    },
  );
}

async function smokeNativeCli(): Promise<SmokeResult> {
  const available = await executableAvailable("gh");
  if (!available) {
    return skipped(
      "native-cli",
      "native-cli",
      "native CLI operation reaches its declared executable",
      "optional gh executable is not installed",
    );
  }
  return executeSmoke(
    "native-cli",
    "native-cli",
    "native CLI operation reaches its declared executable",
    async () => {
      const result = await unicli([
        "gh",
        "release",
        "jackwener/opencli",
        "--limit",
        "1",
      ]);
      assertEnvelopeOk(result.value);
      return {
        elapsedMs: result.elapsedMs,
        detail: "gh/release completed through the argv-only subprocess adapter",
      };
    },
  );
}

async function smokeBrowserSemantic(): Promise<SmokeResult> {
  const session = `capability-smoke-${randomUUID()}`;
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><body><main><h1>Uni-CLI capability smoke</h1><button>Run</button></main></body></html>",
    );
  });
  const address = await new Promise<{ port: number }>((resolvePromise) => {
    fixture.listen(0, "127.0.0.1", () => {
      const bound = fixture.address();
      if (!bound || typeof bound === "string") {
        throw new Error("local browser fixture did not expose a TCP port");
      }
      resolvePromise({ port: bound.port });
    });
  });
  const startedAt = Date.now();
  try {
    await unicli([
      "browser",
      "--provider",
      "managed",
      "--visibility",
      "hidden",
      "--ephemeral",
      "--session",
      session,
      "start",
    ]);
    await unicli([
      "browser",
      "--provider",
      "managed",
      "--visibility",
      "hidden",
      "--ephemeral",
      "--session",
      session,
      "open",
      `http://127.0.0.1:${String(address.port)}/`,
    ]);
    const state = await unicli([
      "browser",
      "--provider",
      "managed",
      "--visibility",
      "hidden",
      "--ephemeral",
      "--session",
      session,
      "state",
    ]);
    assertEnvelopeOk(state.value);
    if (!JSON.stringify(state.value).includes("Uni-CLI capability smoke")) {
      throw new Error("browser state omitted the local fixture heading");
    }
    return {
      category: "browser-semantic",
      operator: "browser-semantic",
      status: "pass",
      assertion:
        "managed browser reads a real local DOM/accessibility state without foreground CUA",
      elapsed_ms: Date.now() - startedAt,
      detail: "owned hidden target opened and returned semantic page state",
    };
  } catch (error) {
    return {
      category: "browser-semantic",
      operator: "browser-semantic",
      status: "fail",
      assertion:
        "managed browser reads a real local DOM/accessibility state without foreground CUA",
      elapsed_ms: Date.now() - startedAt,
      detail: boundedError(error),
    };
  } finally {
    await unicli(["browser", "session-end", session]).catch(() => undefined);
    fixture.closeAllConnections();
    await new Promise<void>((resolvePromise) =>
      fixture.close(() => resolvePromise()),
    );
  }
}

async function smokeDesktopAccessibility(): Promise<SmokeResult> {
  return executeSmoke(
    "desktop-accessibility",
    "desktop-accessibility",
    "native accessibility provider reads live application structure",
    async () => {
      const result = await unicli(["compute", "apps"]);
      assertEnvelopeOk(result.value);
      return {
        elapsedMs: result.elapsedMs,
        detail:
          "compute/apps completed through the host-native accessibility provider",
      };
    },
  );
}

async function smokeCoordinateDriver(): Promise<SmokeResult> {
  const startedAt = Date.now();
  try {
    const doctor = await unicli(["doctor", "compute", "--providers", "--json"]);
    const check = findDoctorCheck(doctor.value, "cua-driver", "contract-0.2.0");
    if (!check || check.status !== "ok") {
      return {
        category: "coordinate-driver",
        operator: "visual-coordinate",
        status: "skip",
        assertion:
          "coordinate control is explicit, desktop-scoped, and contract-checked before action",
        elapsed_ms: Date.now() - startedAt,
        detail:
          check?.detail ??
          "optional Cua Driver provider is not available on this host",
      };
    }

    const screenshot = await unicli([
      "compute",
      "screenshot",
      "--via",
      "driver",
    ]);
    assertEnvelopeOk(screenshot.value);
    const observation = findVisualObservationRef(screenshot.value);
    if (!observation) {
      throw new Error(
        "live Cua Driver screenshot omitted its visual-observation ref",
      );
    }

    const route = await unicli([
      "compute",
      "route",
      "point-click",
      "--params",
      JSON.stringify({ x: 1, y: 1, observation }),
      "--via",
      "driver",
    ]);
    assertEnvelopeOk(route.value);
    if (
      !JSON.stringify(route.value).includes('"transport":"cua-driver"') &&
      !JSON.stringify(route.value).includes('"transport": "cua-driver"')
    ) {
      throw new Error("explicit point route did not select cua-driver");
    }
    return {
      category: "coordinate-driver",
      operator: "visual-coordinate",
      status: "pass",
      assertion:
        "coordinate control is explicit, desktop-scoped, and contract-checked before action",
      elapsed_ms: Date.now() - startedAt,
      detail:
        "Cua Driver contract 0.2.0 returned a live desktop capture and provider-bound coordinate route without executing the click",
    };
  } catch (error) {
    return {
      category: "coordinate-driver",
      operator: "visual-coordinate",
      status: "fail",
      assertion:
        "coordinate control is explicit, desktop-scoped, and contract-checked before action",
      elapsed_ms: Date.now() - startedAt,
      detail: boundedError(error),
    };
  }
}

async function executeSmoke(
  category: SmokeResult["category"],
  operator: SmokeResult["operator"],
  assertion: string,
  operation: () => Promise<{ elapsedMs: number; detail: string }>,
): Promise<SmokeResult> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    return {
      category,
      operator,
      status: "pass",
      assertion,
      elapsed_ms: result.elapsedMs,
      detail: result.detail,
    };
  } catch (error) {
    return {
      category,
      operator,
      status: "fail",
      assertion,
      elapsed_ms: Date.now() - startedAt,
      detail: boundedError(error),
    };
  }
}

function skipped(
  category: SmokeResult["category"],
  operator: SmokeResult["operator"],
  assertion: string,
  detail: string,
): SmokeResult {
  return {
    category,
    operator,
    status: "skip",
    assertion,
    elapsed_ms: 0,
    detail,
  };
}

async function unicli(args: readonly string[]): Promise<CommandResult> {
  const startedAt = Date.now();
  const result = await runContainedProcess(
    process.execPath,
    [tsxCli, unicliSource, "-f", "json", ...args],
    {
      cwd: root,
      timeoutMs: 45_000,
      env: process.env,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      bounded(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `unicli exited ${String(result.exitCode)}`,
      ),
    );
  }
  try {
    return {
      value: JSON.parse(result.stdout),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    throw new Error(`unicli emitted invalid JSON: ${boundedError(error)}`);
  }
}

async function executableAvailable(command: string): Promise<boolean> {
  try {
    const result = await runContainedProcess(command, ["--version"], {
      timeoutMs: 5_000,
      env: process.env,
    });
    return result.exitCode === 0;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function assertEnvelopeOk(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { ok?: unknown }).ok !== true
  ) {
    throw new Error(
      `command returned a non-success envelope: ${bounded(JSON.stringify(value))}`,
    );
  }
}

function findDoctorCheck(
  value: unknown,
  transport: string,
  name: string,
): { status?: unknown; detail?: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const checks = (value as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return undefined;
  return checks.find(
    (entry): entry is { status?: unknown; detail?: string } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { transport?: unknown }).transport === transport &&
      (entry as { name?: unknown }).name === name,
  );
}

function findVisualObservationRef(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const observation = (data as { observation?: unknown }).observation;
  if (typeof observation !== "object" || observation === null) {
    return undefined;
  }
  const ref = (observation as { ref?: unknown }).ref;
  return typeof ref === "string" && ref.length > 0 ? ref : undefined;
}

function boundedError(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error));
}

function bounded(value: string, maximum = 800): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1)}…`;
}
