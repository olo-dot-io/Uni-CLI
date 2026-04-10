/**
 * External CLI passthrough — execute third-party CLIs with smart output wrapping.
 *
 * Security:
 *   - Uses `execFileSync` (no shell) to prevent command injection.
 *   - Binary name is looked up from the trusted YAML registry, never from user input.
 *
 * Output behavior:
 *   - TTY stdout  → raw passthrough (human-readable)
 *   - Piped stdout → attempt JSON parse; wrap as `{"text": "..."}` on failure
 *   - stderr is always passed through
 */

import { execFileSync } from "node:child_process";
import type { ExternalCli } from "./index.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Execute an external CLI command with passthrough.
 *
 * When piped (non-TTY), attempt to parse JSON output or wrap as text.
 * Exits the process with the child's exit code on failure.
 */
export function executeExternal(cli: ExternalCli, args: string[]): void {
  const isTTY = process.stdout.isTTY ?? false;

  try {
    const stdout = execFileSync(cli.binary, args, {
      stdio: isTTY ? "inherit" : ["inherit", "pipe", "inherit"],
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024, // 50 MB
    });

    // In TTY mode execFileSync with stdio "inherit" returns null
    if (!isTTY && stdout) {
      const output = stdout.toString("utf-8");

      // Try to parse as JSON and re-emit (validates + normalizes)
      try {
        const parsed: unknown = JSON.parse(output);
        process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
      } catch {
        // Not JSON — wrap as structured text object
        const trimmed = output.trim();
        if (trimmed.length > 0) {
          process.stdout.write(JSON.stringify({ text: trimmed }) + "\n");
        }
      }
    }
  } catch (err: unknown) {
    // execFileSync throws on non-zero exit — extract code and forward
    if (isExecError(err)) {
      // If there was stdout content in piped mode, it's in err.stdout
      if (!isTTY && err.stdout && err.stdout.length > 0) {
        const output = err.stdout.toString("utf-8").trim();
        if (output.length > 0) {
          try {
            const parsed: unknown = JSON.parse(output);
            process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
          } catch {
            process.stdout.write(JSON.stringify({ text: output }) + "\n");
          }
        }
      }

      process.exit(typeof err.status === "number" ? err.status : 1);
    }

    // Unknown error shape — re-throw
    throw err;
  }
}

// ── Type guard ──────────────────────────────────────────────────────────

interface ExecError {
  status: number | null;
  stdout: Buffer | null;
  stderr: Buffer | null;
}

function isExecError(err: unknown): err is ExecError {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err
  );
}
