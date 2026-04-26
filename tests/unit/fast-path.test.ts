import { describe, expect, it, vi } from "vitest";
import { tryRunFastPath } from "../../src/fast-path.js";

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
    };
    expect(plan).toMatchObject({
      command: "binance.price",
      args: { symbol: "BTCUSDT" },
      adapter_path: "src/adapters/binance/price.yaml",
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
