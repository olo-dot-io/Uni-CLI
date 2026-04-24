import { existsSync } from "node:fs";
import type { Command } from "commander";
import {
  createAdapterSkeleton,
  missingStrictMemoryFiles,
  parseAdapterTarget,
} from "../browser/adapter-authoring.js";
import {
  deriveFixture,
  expandFixtureArgs,
  fixturePath,
  loadFixture,
  validateRows,
  writeFixture,
  type Fixture,
  type FixtureArgs,
} from "../browser/verify-fixture.js";
import { resolveArgs, type ResolvedArgs } from "../engine/args.js";
import { buildInvocation, execute } from "../engine/kernel/execute.js";
import {
  makeCtx,
  type AgentContext,
  type AgentError,
} from "../output/envelope.js";
import { detectFormat, format } from "../output/formatter.js";
import type { AdapterArg, OutputFormat } from "../types.js";

type BrowserVerifyOptions = {
  writeFixture?: boolean;
  updateFixture?: boolean;
  strictMemory?: boolean;
};

type VerifyInvocation = NonNullable<ReturnType<typeof buildInvocation>>;
type VerifyExecution = {
  result: Awaited<ReturnType<typeof execute>>;
  rows: Record<string, unknown>[];
  argSource: ResolvedArgs["source"];
};

type FormatData = unknown[] | Record<string, unknown> | null | undefined;

type VerifyData = Record<string, unknown> & {
  target: string;
  argSource: ResolvedArgs["source"];
  rowCount: number;
  exitCode: number;
  fixturePath: string;
  writtenFixture: string | null;
  fixtureFailures: ReturnType<typeof validateRows>;
  memory: { missing: string[] };
};

function parseFixtureCliArgs(
  tokens: string[],
  schema: AdapterArg[],
): { opts: Record<string, unknown>; positionals: string[] } {
  const boolArgs = new Set(
    schema.filter((arg) => arg.type === "bool").map((arg) => arg.name),
  );
  const opts: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    if (raw.startsWith("no-")) {
      opts[raw.slice(3)] = false;
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      opts[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }

    const next = tokens[i + 1];
    if (next === undefined || next.startsWith("--")) {
      opts[raw] = boolArgs.has(raw) ? "true" : true;
      continue;
    }
    opts[raw] = next;
    i += 1;
  }

  return { opts, positionals };
}

function resolveBrowserVerifyArgs(
  args: FixtureArgs | undefined,
  schema: AdapterArg[],
): ResolvedArgs {
  if (args === undefined) return { args: {}, source: "internal" };
  const parsed = Array.isArray(args)
    ? parseFixtureCliArgs(expandFixtureArgs(args), schema)
    : { opts: args, positionals: [] };
  const resolved = resolveArgs({
    opts: parsed.opts,
    positionals: parsed.positionals,
    schema,
    stdinIsTTY: true,
  });
  return { ...resolved, source: "internal" };
}

function emitError(
  ctx: AgentContext,
  startedAt: number,
  fmt: OutputFormat,
  error: AgentError,
  exitCode: number,
  data: FormatData = null,
): void {
  ctx.error = error;
  ctx.duration_ms = Date.now() - startedAt;
  console.error(format(data, undefined, fmt, ctx));
  process.exitCode = exitCode;
}

function strictMemoryError(missing: string[]): AgentError {
  return {
    code: "not_found",
    message: `Missing site memory files: ${missing.join(", ")}`,
    suggestion:
      "Run browser analyze/explore, write notes, and seed a fixture with --write-fixture.",
    retryable: false,
  };
}

function adapterNotFoundError(site: string, command: string): AgentError {
  return {
    code: "not_found",
    message: `Adapter not found: ${site}/${command}`,
    suggestion: `Create one with: unicli browser init ${site}/${command}`,
    retryable: false,
  };
}

function fixtureValidationError(count: number): AgentError {
  return {
    code: "invalid_input",
    message: `${String(count)} fixture validation failure(s)`,
    retryable: false,
  };
}

function internalError(err: unknown): AgentError {
  return {
    code: "internal_error",
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}

function buildVerifyInvocation(
  site: string,
  command: string,
  currentFixture: Fixture | null,
): VerifyInvocation | null {
  const inv = buildInvocation("cli", site, command, {
    args: {},
    source: "internal",
  });
  if (!inv) return null;
  return {
    ...inv,
    bag: resolveBrowserVerifyArgs(
      currentFixture?.args,
      inv.command.adapterArgs ?? [],
    ),
  };
}

function collectObjectRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.filter(
    (row): row is Record<string, unknown> =>
      row != null && typeof row === "object" && !Array.isArray(row),
  );
}

async function executeVerifyInvocation(
  inv: VerifyInvocation,
): Promise<VerifyExecution> {
  const result = await execute(inv);
  return {
    result,
    rows: collectObjectRows(result.results),
    argSource: inv.bag.source,
  };
}

function resolveVerifyFixture(
  site: string,
  command: string,
  rows: Record<string, unknown>[],
  currentFixture: Fixture | null,
  opts: BrowserVerifyOptions,
): { fixture: Fixture | null; writtenFixture: string | null } {
  const shouldWrite =
    opts.updateFixture === true ||
    (opts.writeFixture === true && !existsSync(fixturePath(site, command)));
  if (!shouldWrite) {
    return { fixture: currentFixture, writtenFixture: null };
  }
  const writtenFixture = writeFixture(
    site,
    command,
    deriveFixture(rows, currentFixture?.args),
  );
  return { fixture: loadFixture(site, command), writtenFixture };
}

function buildVerifyData(
  target: string,
  site: string,
  command: string,
  execution: VerifyExecution,
  writtenFixture: string | null,
  fixtureFailures: ReturnType<typeof validateRows>,
  missing: string[],
): VerifyData {
  return {
    target,
    argSource: execution.argSource,
    rowCount: execution.rows.length,
    exitCode: execution.result.exitCode,
    fixturePath: fixturePath(site, command),
    writtenFixture,
    fixtureFailures,
    memory: { missing },
  };
}

function runBrowserInit(
  program: Command,
  target: string,
  opts: { force?: boolean },
): void {
  const startedAt = Date.now();
  const ctx = makeCtx("browser.init", startedAt);
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  try {
    const data = createAdapterSkeleton(target, { force: opts.force });
    ctx.duration_ms = Date.now() - startedAt;
    console.log(format({ ...data }, undefined, fmt, ctx));
  } catch (err) {
    emitError(
      ctx,
      startedAt,
      fmt,
      {
        code: "invalid_input",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      },
      78,
    );
  }
}

async function runBrowserVerify(
  program: Command,
  target: string,
  opts: BrowserVerifyOptions,
): Promise<void> {
  const startedAt = Date.now();
  const ctx = makeCtx("browser.verify", startedAt);
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  try {
    const { site, command } = parseAdapterTarget(target);
    const missing = missingStrictMemoryFiles(site, command);
    if (opts.strictMemory && missing.length > 0) {
      emitError(ctx, startedAt, fmt, strictMemoryError(missing), 1);
      return;
    }

    const currentFixture = loadFixture(site, command);
    const inv = buildVerifyInvocation(site, command, currentFixture);
    if (!inv) {
      emitError(ctx, startedAt, fmt, adapterNotFoundError(site, command), 1);
      return;
    }

    const execution = await executeVerifyInvocation(inv);
    const { fixture, writtenFixture } = resolveVerifyFixture(
      site,
      command,
      execution.rows,
      currentFixture,
      opts,
    );
    const fixtureFailures = fixture
      ? validateRows(execution.rows, fixture)
      : [];
    const data = buildVerifyData(
      target,
      site,
      command,
      execution,
      writtenFixture,
      fixtureFailures,
      missing,
    );

    if (execution.result.error) {
      emitError(
        ctx,
        startedAt,
        fmt,
        execution.result.error,
        execution.result.exitCode,
        data,
      );
      return;
    }
    if (fixtureFailures.length > 0) {
      emitError(
        ctx,
        startedAt,
        fmt,
        fixtureValidationError(fixtureFailures.length),
        1,
        data,
      );
      return;
    }

    ctx.duration_ms = Date.now() - startedAt;
    console.log(format(data, undefined, fmt, ctx));
    process.exitCode = execution.result.exitCode;
  } catch (err) {
    emitError(ctx, startedAt, fmt, internalError(err), 1);
  }
}

export function registerBrowserAdapterAuthoringSubcommands(
  browser: Command,
  program: Command,
): void {
  browser
    .command("init <target>")
    .description("Create a user YAML adapter skeleton at ~/.unicli/adapters")
    .option("--force", "overwrite an existing skeleton")
    .action((target: string, opts: { force?: boolean }) =>
      runBrowserInit(program, target, opts),
    );

  browser
    .command("verify <target>")
    .description("Run an adapter and validate its site-memory fixture")
    .option("--write-fixture", "write a starter fixture when none exists")
    .option("--update-fixture", "overwrite fixture with current output")
    .option(
      "--strict-memory",
      "fail when endpoints, notes, or verify fixture memory is missing",
    )
    .action((target: string, opts: BrowserVerifyOptions) =>
      runBrowserVerify(program, target, opts),
    );
}
