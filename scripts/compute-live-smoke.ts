import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ComputeSmokeStepResult {
  id: string;
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  exit_code?: number;
  duration_ms?: number;
  stdout?: string;
  stderr?: string;
}

export interface ComputeSmokeReport {
  schema_version: 1;
  ok: boolean;
  platform: string;
  app: string;
  buttonName: string;
  startedAt: string;
  finishedAt: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  plan: ComputeSmokePlan;
  results: ComputeSmokeStepResult[];
}

export type ComputeSmokeExecutor = (
  argv: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface ComputeSmokeCommand {
  id: string;
  argv: string[];
  mutatesHost: boolean;
  description: string;
  refFromPreviousFind?: boolean;
}

export interface ComputeSmokePlan {
  platform: string;
  app: string;
  buttonName: string;
  commands: ComputeSmokeCommand[];
}

interface SmokeOptions {
  platform?: string;
  app?: string;
  buttonName?: string;
}

const PLATFORM_DEFAULTS: Record<string, { app: string; buttonName: string }> = {
  darwin: { app: "Calculator", buttonName: "5" },
  win32: { app: "Calculator", buttonName: "Five" },
  linux: { app: "gnome-calculator", buttonName: "5" },
};

export function computeLiveSmokePlan(
  platform = process.platform,
  opts: SmokeOptions = {},
): ComputeSmokePlan {
  const defaults = PLATFORM_DEFAULTS[platform] ?? PLATFORM_DEFAULTS.darwin;
  const app = opts.app ?? defaults.app;
  const buttonName = opts.buttonName ?? defaults.buttonName;

  return {
    platform,
    app,
    buttonName,
    commands: [
      {
        id: "doctor",
        argv: ["doctor", "compute", "--json"],
        mutatesHost: false,
        description: "Inspect compute transport availability and remedies.",
      },
      {
        id: "apps",
        argv: ["-f", "json", "compute", "apps"],
        mutatesHost: false,
        description: "List running desktop apps through the compute cascade.",
      },
      {
        id: "launch",
        argv: ["-f", "json", "compute", "launch", app],
        mutatesHost: true,
        description: "Launch the platform calculator app.",
      },
      {
        id: "snapshot",
        argv: [
          "-f",
          "json",
          "compute",
          "snapshot",
          "--app",
          app,
          "--format",
          "compact",
          "--max-depth",
          "4",
        ],
        mutatesHost: false,
        description: "Capture a compact accessibility snapshot.",
      },
      {
        id: "find-button",
        argv: [
          "-f",
          "json",
          "compute",
          "find",
          "--role",
          "button",
          "--name",
          buttonName,
          "--first",
        ],
        mutatesHost: false,
        description:
          "Resolve a calculator button ref from the persisted snapshot.",
      },
      {
        id: "wait-button",
        argv: [
          "-f",
          "json",
          "compute",
          "wait",
          "--ref",
          "<ref-from-find>",
          "--timeout",
          "5000",
        ],
        mutatesHost: false,
        refFromPreviousFind: true,
        description: "Verify the resolved ref remains waitable.",
      },
      {
        id: "assert-button",
        argv: [
          "-f",
          "json",
          "compute",
          "assert",
          "--ref",
          "<ref-from-find>",
          "--state",
          "enabled",
        ],
        mutatesHost: false,
        refFromPreviousFind: true,
        description: "Assert the resolved ref is enabled.",
      },
      {
        id: "click-button",
        argv: [
          "-f",
          "json",
          "compute",
          "click",
          "<ref-from-find>",
          "--background",
        ],
        mutatesHost: true,
        refFromPreviousFind: true,
        description:
          "Actuate the resolved button without explicit focus theft.",
      },
      {
        id: "type-button",
        argv: [
          "-f",
          "json",
          "compute",
          "type",
          "<ref-from-find>",
          "1",
          "--focus",
        ],
        mutatesHost: true,
        refFromPreviousFind: true,
        description:
          "Exercise compute type against the resolved ref; override app/button if needed for a text field smoke.",
      },
      {
        id: "scroll-button",
        argv: [
          "-f",
          "json",
          "compute",
          "scroll",
          "<ref-from-find>",
          "--direction",
          "down",
          "--amount",
          "120",
        ],
        mutatesHost: true,
        refFromPreviousFind: true,
        description:
          "Exercise compute scroll routing against the resolved ref; override target when the app has a scrollable element.",
      },
      {
        id: "screenshot",
        argv: ["-f", "json", "compute", "screenshot", "--app", app],
        mutatesHost: false,
        description: "Capture a screenshot through the compute cascade.",
      },
    ],
  };
}

function readFlag(name: string, args: string[]): boolean {
  return args.includes(name);
}

function readOption(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

export function buildComputeSmokeReport(
  plan: ComputeSmokePlan,
  results: ComputeSmokeStepResult[],
  times: { startedAt: string; finishedAt: string },
): ComputeSmokeReport {
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter(
    (result) => !result.skipped && result.ok === false,
  ).length;
  const passed = results.filter((result) => result.ok === true).length;
  return {
    schema_version: 1,
    ok: failed === 0,
    platform: plan.platform,
    app: plan.app,
    buttonName: plan.buttonName,
    startedAt: times.startedAt,
    finishedAt: times.finishedAt,
    summary: {
      total: results.length,
      passed,
      failed,
      skipped,
    },
    plan,
    results,
  };
}

export async function writeComputeSmokeReport(
  outputPath: string,
  report: ComputeSmokeReport,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function renderPlan(plan: ComputeSmokePlan): string {
  const lines = [
    `# Uni-CLI compute live smoke (${plan.platform})`,
    "",
    `App: ${plan.app}`,
    `Button: ${plan.buttonName}`,
    "",
  ];
  for (const command of plan.commands) {
    const prefix = command.mutatesHost ? "[mutates]" : "[read-only]";
    lines.push(`- ${prefix} ${command.id}: unicli ${command.argv.join(" ")}`);
  }
  lines.push(
    "",
    "Run with `npm run compute:smoke -- --run --include-mutating` to execute the full smoke.",
  );
  return `${lines.join("\n")}\n`;
}

function readAliasFromEnvelope(stdout: string): string | undefined {
  try {
    const envelope = JSON.parse(stdout) as {
      data?: { alias?: unknown; ref?: unknown; stable?: unknown };
    };
    const alias =
      envelope.data?.alias ?? envelope.data?.ref ?? envelope.data?.stable;
    return typeof alias === "string" && alias ? alias : undefined;
  } catch {
    return undefined;
  }
}

function defaultExecutor(refsPath: string): ComputeSmokeExecutor {
  return async (argv) => {
    try {
      const child = await execFileAsync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["tsx", "src/main.ts", ...argv],
        {
          cwd: join(import.meta.dirname, ".."),
          env: {
            ...process.env,
            UNICLI_COMPUTE_REFS_PATH: refsPath,
          },
          maxBuffer: 1024 * 1024,
        },
      );
      return { stdout: child.stdout, stderr: child.stderr, exitCode: 0 };
    } catch (error) {
      const record = error as {
        stdout?: unknown;
        stderr?: unknown;
        code?: unknown;
      };
      return {
        stdout: typeof record.stdout === "string" ? record.stdout : "",
        stderr:
          typeof record.stderr === "string" ? record.stderr : String(error),
        exitCode: typeof record.code === "number" ? record.code : 1,
      };
    }
  };
}

export async function runComputeLiveSmokePlan(
  plan: ComputeSmokePlan,
  opts: {
    includeMutating: boolean;
    json: boolean;
    execute?: ComputeSmokeExecutor;
  },
): Promise<ComputeSmokeStepResult[]> {
  const refsDir = await mkdtemp(join(tmpdir(), "unicli-compute-smoke-"));
  const refsPath = join(refsDir, "refs.json");
  const execute = opts.execute ?? defaultExecutor(refsPath);
  const results: ComputeSmokeStepResult[] = [];
  let resolvedRef: string | undefined;

  try {
    for (const command of plan.commands) {
      if (command.mutatesHost && !opts.includeMutating) {
        results.push({
          id: command.id,
          skipped: true,
          reason: "mutating step",
        });
        continue;
      }
      const argv = command.argv.map((arg) =>
        arg === "<ref-from-find>" ? (resolvedRef ?? arg) : arg,
      );
      if (command.refFromPreviousFind && !resolvedRef) {
        results.push({ id: command.id, skipped: true, reason: "missing ref" });
        continue;
      }

      const started = Date.now();
      const child = await execute(argv);
      if (command.id === "find-button" && child.exitCode === 0) {
        resolvedRef = readAliasFromEnvelope(child.stdout);
      }
      results.push({
        id: command.id,
        ok: child.exitCode === 0,
        exit_code: child.exitCode,
        duration_ms: Date.now() - started,
        stdout: opts.json ? child.stdout.trim() : undefined,
        stderr: child.stderr.trim() || undefined,
      });
    }
    return results;
  } finally {
    await rm(refsDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = readFlag("--json", args);
  const output = readOption("--output", args);
  const plan = computeLiveSmokePlan(readOption("--platform", args), {
    app: readOption("--app", args),
    buttonName: readOption("--button", args),
  });

  if (!readFlag("--run", args)) {
    if (output) {
      const now = new Date().toISOString();
      await writeComputeSmokeReport(
        output,
        buildComputeSmokeReport(plan, [], {
          startedAt: now,
          finishedAt: now,
        }),
      );
    }
    console.log(json ? JSON.stringify(plan, null, 2) : renderPlan(plan));
    return;
  }

  const startedAt = new Date().toISOString();
  const results = await runComputeLiveSmokePlan(plan, {
    includeMutating: readFlag("--include-mutating", args),
    json,
  });
  const report = buildComputeSmokeReport(plan, results, {
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  if (output) await writeComputeSmokeReport(output, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("compute-live-smoke.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
