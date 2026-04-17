/**
 * `unicli auth` envelope tests — verify the v2 envelope contract on the
 * three auth subcommands (setup, check, list) introduced by T5.
 *
 * We intentionally isolate the cookie directory via UNICLI_COOKIE_DIR so the
 * tests never read the user's real cookies.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAuthCommands } from "../../../src/commands/auth.js";
import { validateEnvelope } from "../../../src/output/envelope.js";

let cookieDir: string;
let originalCookieDir: string | undefined;

function captureStdout(): {
  getStdout: () => string;
  getStderr: () => string;
  restore: () => void;
} {
  let out = "";
  let err = "";
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origLog = console.log;
  const origError = console.error;
  console.log = ((...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    err += args.map(String).join(" ") + "\n";
  }) as typeof console.error;
  return {
    getStdout: () => out,
    getStderr: () => err,
    restore: () => {
      console.log = origLog;
      console.error = origError;
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

function parseEnvelopeFromStdout(out: string): Record<string, unknown> {
  // envelope JSON is the last non-empty block; we emit via console.log single call.
  const trimmed = out.trim();
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  return parsed;
}

describe("unicli auth — v2 envelope", () => {
  beforeEach(() => {
    cookieDir = mkdtempSync(join(tmpdir(), "unicli-auth-test-"));
    originalCookieDir = process.env.UNICLI_COOKIE_DIR;
    process.env.UNICLI_COOKIE_DIR = cookieDir;
  });

  afterEach(() => {
    if (originalCookieDir === undefined) {
      delete process.env.UNICLI_COOKIE_DIR;
    } else {
      process.env.UNICLI_COOKIE_DIR = originalCookieDir;
    }
    try {
      rmSync(cookieDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerAuthCommands(program);
    return program;
  }

  it("auth list emits an ok envelope with data=[] when cookie dir is empty", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "auth", "list"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = parseEnvelopeFromStdout(cap.getStdout());
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("auth.list");
    expect(env.data).toEqual([]);
    expect(env.error).toBeNull();
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("auth list emits rows for every cookie file present", async () => {
    writeFileSync(
      join(cookieDir, "twitter.json"),
      JSON.stringify({ auth_token: "t", ct0: "c" }),
    );
    writeFileSync(
      join(cookieDir, "reddit.json"),
      JSON.stringify({ session: "s" }),
    );

    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "auth", "list"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = parseEnvelopeFromStdout(cap.getStdout());
    expect(env.ok).toBe(true);
    expect(env.command).toBe("auth.list");
    const data = env.data as Array<{ site: string; cookie_count: number }>;
    expect(data.length).toBe(2);
    const sites = data.map((d) => d.site).sort();
    expect(sites).toEqual(["reddit", "twitter"]);
    const twitter = data.find((d) => d.site === "twitter");
    expect(twitter?.cookie_count).toBe(2);
  });

  it("auth check emits an error envelope when site is unknown", async () => {
    // Patch process.exit to throw so vitest can observe it.
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__EXIT__${code}`);
    }) as typeof process.exit;

    const cap = captureStdout();
    let exitCode: number | null = null;
    try {
      const program = newProgram();
      try {
        await program.parseAsync(
          ["-f", "json", "auth", "check", "__no_such_site_xxx__"],
          { from: "user" },
        );
      } catch (err) {
        const m = /^__EXIT__(\d+)/.exec((err as Error).message);
        if (m) exitCode = parseInt(m[1], 10);
        else throw err;
      }
    } finally {
      cap.restore();
      process.exit = origExit;
    }

    // USAGE_ERROR = 2 (unknown site) per the auth check implementation.
    expect(exitCode).toBe(2);

    const errText = cap.getStderr().trim();
    // The error envelope is the first non-blank chunk emitted via console.error.
    // Our action emits a multi-line JSON via format() (JSON.stringify(..., null, 2)).
    // Since JSON.stringify produces a single string ending with a newline per
    // console.error call, we can parse the full stderr as one JSON doc.
    const parsed = JSON.parse(errText) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.schema_version).toBe("2");
    expect(parsed.command).toBe("auth.check");
    const eObj = parsed.error as { code: string } | undefined;
    expect(eObj?.code).toBe("invalid_input");
  });
});
