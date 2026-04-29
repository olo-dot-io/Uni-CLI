import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { evalTemplate } from "../template.js";
import {
  matchSensitivePathRealpath,
  buildSensitivePathDenial,
} from "../../permissions/sensitive-paths.js";
import {
  assertRuntimeExecutableAllowed,
  assertRuntimePathAllowed,
} from "../runtime-resource-guard.js";

const execFileAsync = promisify(execFile);

export interface ExecConfig {
  command: string;
  args?: string[];
  parse?: "lines" | "json" | "csv" | "text";
  timeout?: number | string;
  stdin?: string;
  env?: Record<string, string>;
  output_file?: string;
}

function resolveTimeout(
  ctx: PipelineContext,
  timeout: number | string | undefined,
  stepIndex: number,
): number {
  if (timeout === undefined) return 30000;
  if (typeof timeout === "number") return timeout;

  const resolved = evalTemplate(timeout, ctx).trim();
  const numeric = Number(resolved);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;

  throw new PipelineError(
    `exec timeout must resolve to a number: ${resolved}`,
    {
      step: stepIndex,
      action: "exec",
      config: { timeout },
      errorType: "parse_error",
      suggestion:
        "Use a numeric timeout in milliseconds, or a template that evaluates to one.",
      retryable: false,
      alternatives: [],
    },
  );
}

export async function stepExec(
  ctx: PipelineContext,
  config: ExecConfig,
  stepIndex = -1,
): Promise<PipelineContext> {
  const cmd = evalTemplate(config.command, ctx);
  const execArgs = (config.args ?? []).map((a) => evalTemplate(String(a), ctx));
  const timeout = resolveTimeout(ctx, config.timeout, stepIndex);
  assertRuntimeExecutableAllowed(ctx, {
    action: "exec",
    step: stepIndex,
    config,
    command: cmd,
  });

  // Sensitive-path deny list — realpath-aware so symlink smuggling is
  // blocked too. Cannot be overridden by permission mode.
  for (const arg of execArgs) {
    if (typeof arg !== "string" || arg.length === 0) continue;
    if (!arg.startsWith("/") && !arg.startsWith("~/")) continue;
    const expanded = arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg;
    const matched = matchSensitivePathRealpath(expanded);
    if (matched) {
      const denial = buildSensitivePathDenial(expanded);
      throw new PipelineError("sensitive_path_denied", {
        step: stepIndex,
        action: "exec",
        config: {
          command: cmd,
          args: execArgs,
          denial_path: denial.path,
          denial_pattern: denial.pattern,
        },
        errorType: "assertion_failed",
        suggestion: denial.hint,
        retryable: false,
        alternatives: [],
      });
    }
  }

  let envOption: NodeJS.ProcessEnv | undefined;
  if (config.env) {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.env)) {
      resolved[k] = evalTemplate(String(v), ctx);
    }
    envOption = { ...process.env, ...resolved };
  }

  const stdinContent = config.stdin
    ? evalTemplate(config.stdin, ctx)
    : undefined;

  const outputFile = config.output_file
    ? evalTemplate(config.output_file, ctx)
    : undefined;
  if (outputFile) {
    assertRuntimePathAllowed(ctx, {
      action: "exec",
      step: stepIndex,
      config,
      path: outputFile,
      access: "write",
    });
  }

  try {
    let stdout: string;

    if (stdinContent !== undefined) {
      const { spawn } = await import("node:child_process");
      stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(cmd, execArgs, {
          timeout,
          env: envOption,
          stdio: ["pipe", "pipe", "pipe"],
        });

        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        child.stdout.on("data", (c: Buffer) => chunks.push(c));
        child.stderr.on("data", (c: Buffer) => errChunks.push(c));

        child.on("error", (err) => reject(err));
        child.on("close", (code) => {
          if (code !== 0) {
            const stderr = Buffer.concat(errChunks).toString("utf8");
            reject(
              new Error(
                `Process exited with code ${code}${stderr ? `: ${stderr}` : ""}`,
              ),
            );
          } else {
            resolve(Buffer.concat(chunks).toString("utf8"));
          }
        });

        child.stdin.write(stdinContent);
        child.stdin.end();
      });
    } else {
      const opts: {
        timeout: number;
        maxBuffer: number;
        env?: NodeJS.ProcessEnv;
      } = {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      };
      if (envOption) opts.env = envOption;
      ({ stdout } = await execFileAsync(cmd, execArgs, opts));
    }

    if (outputFile) {
      const { stat } = await import("node:fs/promises");
      try {
        const info = await stat(outputFile);
        return { ...ctx, data: { file: outputFile, size: info.size } };
      } catch {
        throw new PipelineError(
          `exec "${cmd}" did not produce expected output file: ${outputFile}`,
          {
            step: stepIndex,
            action: "exec",
            config: { command: cmd, args: execArgs },
            errorType: "parse_error",
            suggestion: `Check that the command writes to "${outputFile}". Verify the path is correct.`,
            retryable: false,
            alternatives: [],
          },
        );
      }
    }

    let data: unknown;
    switch (config.parse ?? "lines") {
      case "json":
        data = JSON.parse(stdout);
        break;
      case "lines":
        data = stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => ({ line }));
        break;
      case "csv": {
        const lines = stdout.split("\n").filter(Boolean);
        if (lines.length < 2) {
          data = [];
          break;
        }
        const headers = lines[0].split(",").map((h) => h.trim());
        data = lines.slice(1).map((line) => {
          const vals = line.split(",");
          const row: Record<string, string> = {};
          headers.forEach((h, i) => {
            row[h] = (vals[i] ?? "").trim();
          });
          return row;
        });
        break;
      }
      case "text":
      default:
        data = stdout;
    }

    return { ...ctx, data };
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const isExecTransient = /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(
      msg,
    );
    throw new PipelineError(`exec "${cmd}" failed: ${msg}`, {
      step: stepIndex,
      action: "exec",
      config: { command: cmd, args: execArgs },
      errorType: isExecTransient ? "timeout" : "parse_error",
      suggestion: `Check that "${cmd}" is installed and accessible. Run: which ${cmd}`,
      retryable: isExecTransient,
      alternatives: [],
    });
  }
}

registerStep("exec", stepExec as StepHandler);
