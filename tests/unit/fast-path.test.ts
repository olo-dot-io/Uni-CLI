import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryRunFastPath } from "../../src/fast-path.js";
import { createApprovalStore } from "../../src/engine/approval-store.js";
import { evaluateOperationPolicy } from "../../src/engine/operation-policy.js";
import { ExitCode } from "../../src/types.js";

function makeIo(): {
  stdout: string[];
  stderr: string[];
  io: {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("CLI fast path", () => {
  it("serves list from the manifest without falling through to full CLI boot", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      ["node", "unicli", "-f", "json", "list", "--site", "twitter"],
      io,
    );

    expect(handled).toBe(true);
    const env = JSON.parse(stdout.join("")) as {
      command: string;
      data: Array<{ site: string; command: string }>;
    };
    expect(env.command).toBe("core.list");
    expect(env.data.length).toBeGreaterThan(0);
    expect(env.data.every((row) => row.site.includes("twitter"))).toBe(true);
  });

  it("preserves quarantine tags in list output", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      ["node", "unicli", "-f", "json", "list", "--site", "36kr"],
      io,
    );

    expect(handled).toBe(true);
    const env = JSON.parse(stdout.join("")) as {
      data: Array<{ command: string; auth: string }>;
    };
    expect(env.data).toContainEqual(
      expect.objectContaining({
        command: "latest",
        auth: expect.stringContaining("[quarantined]"),
      }),
    );
  });

  it("falls through when the generated manifest is absent", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actualFs,
      existsSync: () => false,
    }));

    const { tryRunFastPath: tryRunMissingManifestFastPath } =
      await import("../../src/fast-path.js");
    const { stdout, stderr, io } = makeIo();

    const handled = tryRunMissingManifestFastPath(
      ["node", "unicli", "-f", "json", "list"],
      io,
    );

    vi.doUnmock("node:fs");
    vi.resetModules();

    expect(handled).toBe(false);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("serves search from the search index", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      ["node", "unicli", "-f", "json", "search", "twitter", "trending"],
      io,
    );

    expect(handled).toBe(true);
    const env = JSON.parse(stdout.join("")) as {
      command: string;
      data: Array<{ command: string }>;
    };
    expect(env.command).toBe("core.search");
    expect(env.data.some((row) => row.command === "twitter trending")).toBe(
      true,
    );
  });

  it("serves describe command schemas from manifest metadata", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      ["node", "unicli", "describe", "twitter", "search"],
      io,
    );

    expect(handled).toBe(true);
    const payload = JSON.parse(stdout.join("")) as {
      args_schema: {
        properties: Record<string, { type: string }>;
        required: string[];
      };
      channels: { shell: string };
    };
    expect(payload.args_schema.properties.query).toMatchObject({
      type: "string",
    });
    expect(payload.args_schema.required).toContain("query");
    expect(payload.channels.shell).toContain("<query>");
  });

  it("emits structured invalid permission profile errors for describe", () => {
    const { stdout, stderr, io } = makeIo();

    const handled = tryRunFastPath(
      [
        "node",
        "unicli",
        "-f",
        "json",
        "--permission-profile",
        "typo",
        "describe",
        "twitter",
        "search",
      ],
      io,
    );

    expect(handled).toBe(true);
    expect(stdout).toEqual([]);
    expect(process.exitCode).toBe(ExitCode.USAGE_ERROR);
    const env = JSON.parse(stderr.join("")) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string; adapter_path: string };
    };
    expect(env.ok).toBe(false);
    expect(env.command).toBe("twitter.search");
    expect(env.error).toMatchObject({
      code: "invalid_input",
      adapter_path: "src/adapters/twitter/search.ts",
    });
    expect(env.error.message).toContain("invalid permission profile");
  });

  it("serves generated Electron command schemas from manifest metadata", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      ["node", "unicli", "describe", "wechat-work", "type-text"],
      io,
    );

    expect(handled).toBe(true);
    const payload = JSON.parse(stdout.join("")) as {
      args_schema: {
        properties: Record<string, { type: string }>;
        required: string[];
      };
      channels: { shell: string };
      operation_policy: {
        capability_scope: {
          dimensions: {
            desktop: { access: string };
            process: { access: string };
          };
        };
      };
    };
    expect(payload.args_schema.properties.text).toMatchObject({
      type: "string",
    });
    expect(payload.args_schema.properties.target).toMatchObject({
      type: "string",
    });
    expect(payload.args_schema.required).toContain("text");
    expect(payload.channels.shell).toContain("<text>");
    expect(payload.channels.shell).toContain("[--target <str>]");
    expect(payload.operation_policy.capability_scope).toMatchObject({
      dimensions: {
        desktop: { access: "write" },
        process: { access: "write" },
      },
    });
  });

  it("serves repair dry-run without entering the repair loop", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      [
        "node",
        "unicli",
        "-f",
        "json",
        "repair",
        "--dry-run",
        "twitter",
        "search",
      ],
      io,
    );

    expect(handled).toBe(true);
    const env = JSON.parse(stdout.join("")) as {
      command: string;
      data: { mode: string; site: string; command: string };
    };
    expect(env.command).toBe("repair.run");
    expect(env.data).toMatchObject({
      mode: "dry-run",
      site: "twitter",
      command: "search",
    });
  });

  it("serves adapter dry-run plans from the manifest", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      ["node", "unicli", "--dry-run", "binance", "price", "BTCUSDT"],
      io,
    );

    expect(handled).toBe(true);
    const plan = JSON.parse(stdout.join("")) as {
      command: string;
      args: Record<string, unknown>;
      adapter_path: string;
      operation_policy: { profile: string; enforcement: string };
    };
    expect(plan).toMatchObject({
      command: "binance.price",
      args: { symbol: "BTCUSDT" },
      adapter_path: "src/adapters/binance/price.yaml",
      operation_policy: { profile: "open", enforcement: "allow" },
    });
  });

  it("includes manifest resource metadata in adapter dry-run policy", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      ["node", "unicli", "--dry-run", "binance", "price", "BTCUSDT"],
      io,
    );

    expect(handled).toBe(true);
    const plan = JSON.parse(stdout.join("")) as {
      operation_policy: {
        capability_scope: {
          resources?: {
            domains: string[];
          };
          resource_summary?: string[];
        };
      };
    };
    expect(plan.operation_policy.capability_scope.resources?.domains).toEqual([
      "data-api.binance.vision",
    ]);
    expect(plan.operation_policy.capability_scope.resource_summary).toContain(
      "domain:data-api.binance.vision",
    );
  });

  it("emits structured invalid permission profile errors for adapter dry-run", () => {
    const { stdout, stderr, io } = makeIo();

    const handled = tryRunFastPath(
      [
        "node",
        "unicli",
        "-f",
        "json",
        "--dry-run",
        "--permission-profile",
        "typo",
        "twitter",
        "search",
        "agent",
      ],
      io,
    );

    expect(handled).toBe(true);
    expect(stdout).toEqual([]);
    expect(process.exitCode).toBe(ExitCode.USAGE_ERROR);
    const env = JSON.parse(stderr.join("")) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string; adapter_path: string };
    };
    expect(env.ok).toBe(false);
    expect(env.command).toBe("twitter.search");
    expect(env.error).toMatchObject({
      code: "invalid_input",
      adapter_path: "src/adapters/twitter/search.ts",
    });
    expect(env.error.message).toContain("invalid permission profile");
  });

  it("serves user-selected operation policy in adapter dry-run plans", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      [
        "node",
        "unicli",
        "--dry-run",
        "--permission-profile",
        "confirm",
        "slack",
        "send",
        "C0123456789",
        "hello",
      ],
      io,
    );

    expect(handled).toBe(true);
    const plan = JSON.parse(stdout.join("")) as {
      operation_policy: {
        profile: string;
        effect: string;
        risk: string;
        enforcement: string;
        capability_scope: {
          dimensions: {
            account: { access: string };
            network: { access: string };
          };
        };
      };
    };
    expect(plan.operation_policy).toMatchObject({
      profile: "confirm",
      effect: "send_message",
      risk: "high",
      enforcement: "needs_approval",
      capability_scope: {
        dimensions: {
          account: { access: "write" },
          network: { access: "write" },
        },
      },
    });
  });

  it("ignores malformed approval-memory lines in adapter dry-run plans", () => {
    const originalApprovalsPath = process.env.UNICLI_APPROVALS_PATH;
    const tmp = mkdtempSync(join(tmpdir(), "unicli-fast-path-approvals-"));
    const store = createApprovalStore({ path: join(tmp, "approvals.jsonl") });
    const policy = evaluateOperationPolicy({
      site: "slack",
      command: "send",
      description: "Send a message to a Slack channel",
      adapterType: "bridge",
      strategy: "public",
      browser: false,
      args: [
        { name: "channel", required: true },
        { name: "text", required: true },
      ],
      profile: "confirm",
      approved: true,
    });
    writeFileSync(
      store.path,
      `${JSON.stringify({
        key: policy.approval_memory.key,
        decision: "allow",
      })}\n`,
      "utf-8",
    );
    process.env.UNICLI_APPROVALS_PATH = store.path;

    try {
      const { stdout, io } = makeIo();
      const handled = tryRunFastPath(
        [
          "node",
          "unicli",
          "--dry-run",
          "--permission-profile",
          "confirm",
          "slack",
          "send",
          "C0123456789",
          "hello",
        ],
        io,
      );

      expect(handled).toBe(true);
      const plan = JSON.parse(stdout.join("")) as {
        operation_policy: {
          enforcement: string;
          approved: boolean;
          approval_memory: { persistence: string; decision: string };
        };
      };
      expect(plan.operation_policy).toMatchObject({
        enforcement: "needs_approval",
        approved: false,
        approval_memory: {
          persistence: "not_persisted",
          decision: "not_approved",
        },
      });
    } finally {
      if (originalApprovalsPath === undefined) {
        delete process.env.UNICLI_APPROVALS_PATH;
      } else {
        process.env.UNICLI_APPROVALS_PATH = originalApprovalsPath;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves generated Electron adapter dry-run args from the manifest", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      [
        "node",
        "unicli",
        "--dry-run",
        "wechat-work",
        "type-text",
        "hello",
        "--target",
        "文件传输助手",
      ],
      io,
    );

    expect(handled).toBe(true);
    const plan = JSON.parse(stdout.join("")) as {
      command: string;
      args: Record<string, unknown>;
      adapter_path: string;
      target_surface: string;
    };
    expect(plan).toMatchObject({
      command: "wechat-work.type-text",
      args: { text: "hello", target: "文件传输助手" },
      adapter_path: "src/adapters/electron-desktop/electron-desktop.ts",
      target_surface: "desktop",
    });
  });

  it("resolves generated AI chat defaults from the manifest", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      ["node", "unicli", "--dry-run", "chatgpt", "screenshot"],
      io,
    );

    expect(handled).toBe(true);
    const plan = JSON.parse(stdout.join("")) as {
      command: string;
      args: Record<string, unknown>;
      adapter_path: string;
      target_surface: string;
    };
    expect(plan).toMatchObject({
      command: "chatgpt.screenshot",
      args: { path: "./chatgpt-screenshot.png" },
      adapter_path: "src/adapters/chatgpt/chatgpt.ts",
      target_surface: "desktop",
    });
  });

  it("preserves dash-prefixed positional values in adapter dry-run plans", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(
      ["node", "unicli", "--dry-run", "google", "search", "-securityid"],
      io,
    );

    expect(handled).toBe(true);
    const plan = JSON.parse(stdout.join("")) as {
      command: string;
      args: Record<string, unknown>;
    };
    expect(plan).toMatchObject({
      command: "google.search",
      args: { query: "-securityid" },
    });
  });

  it("falls through for adapter execution commands", () => {
    const { stdout, stderr, io } = makeIo();

    const handled = tryRunFastPath(
      ["node", "unicli", "-f", "json", "twitter", "search", "agent"],
      io,
    );

    expect(handled).toBe(false);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("serves site help from the manifest", () => {
    const { stdout, io } = makeIo();

    const handled = tryRunFastPath(["node", "unicli", "twitter", "-h"], io);

    expect(handled).toBe(true);
    const output = stdout.join("");
    expect(output).toContain("Usage: unicli twitter");
    expect(output).toContain("trending");
    expect(output).toContain("search");
  });
});
