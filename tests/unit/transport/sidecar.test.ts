import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StdioSidecarClient } from "../../../src/transport/sidecar.js";

describe("StdioSidecarClient", () => {
  it("kills and awaits an active sidecar before cancellation returns", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-sidecar-cancel-"));
    const markerPath = join(directory, "late-mutation.txt");
    const client = new StdioSidecarClient(process.execPath, [
      "-e",
      `
        const fs = require("node:fs");
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const req = JSON.parse(line);
          if (req.kind === "mutate") {
            setTimeout(() => {
              fs.writeFileSync(${JSON.stringify(markerPath)}, "late mutation");
              process.stdout.write(JSON.stringify({
                id: req.id,
                kind: req.kind,
                ok: true,
                data: { mutated: true },
              }) + "\\n");
            }, 200);
            return;
          }
          process.stdout.write(JSON.stringify({
            id: req.id,
            kind: req.kind,
            ok: true,
            data: { kind: req.kind },
          }) + "\\n");
        });
      `,
    ]);
    const controller = new AbortController();
    const cancellation = new Error("cancel native mutation");

    try {
      const mutation = client.call("mutate", {}, { signal: controller.signal });
      setTimeout(() => controller.abort(cancellation), 20);

      await expect(mutation).rejects.toBe(cancellation);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(markerPath)).toBe(false);
      await expect(client.call("after-cancel", {})).resolves.toEqual({
        kind: "after-cancel",
      });
    } finally {
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("marks active mutation cancellation ambiguous after the frame can commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-sidecar-committed-"));
    const markerPath = join(directory, "committed.txt");
    const client = new StdioSidecarClient(process.execPath, [
      "-e",
      `
        const fs = require("node:fs");
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const req = JSON.parse(line);
          fs.writeFileSync(${JSON.stringify(markerPath)}, "committed");
          setTimeout(() => {
            process.stdout.write(JSON.stringify({
              id: req.id,
              kind: req.kind,
              ok: true,
              data: { mutated: true },
            }) + "\\n");
          }, 500);
        });
      `,
    ]);
    const controller = new AbortController();
    const cancellation = new Error("cancel committed native mutation");

    try {
      const mutation = client.call(
        "mutate",
        {},
        {
          signal: controller.signal,
          cancellationDelivery: "outcome-ambiguous",
        },
      );
      while (!existsSync(markerPath)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      controller.abort(cancellation);

      await expect(mutation).rejects.toMatchObject({
        name: "OperationOutcomeAmbiguousError",
        operation: "mutate",
        cancellationReason: cancellation,
        outcome_ambiguous: true,
      });
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes calls through one in-flight sidecar request", async () => {
    const client = new StdioSidecarClient(process.execPath, [
      "-e",
      `
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        let active = false;
        rl.on("line", (line) => {
          const req = JSON.parse(line);
          const overlap = active;
          active = true;
          setTimeout(() => {
            process.stdout.write(JSON.stringify({
              id: req.id,
              kind: req.kind,
              ok: true,
              data: { id: req.id, overlap },
            }) + "\\n");
            active = false;
          }, 40);
        });
      `,
    ]);

    try {
      const [first, second] = await Promise.all([
        client.call<{ overlap: boolean }>("first", {}),
        client.call<{ overlap: boolean }>("second", {}),
      ]);

      expect(first.overlap).toBe(false);
      expect(second.overlap).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("completes 100 concurrent calls in sidecar order", async () => {
    const client = new StdioSidecarClient(process.execPath, [
      "-e",
      `
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        let active = false;
        let sequence = 0;
        rl.on("line", (line) => {
          const req = JSON.parse(line);
          const overlap = active;
          active = true;
          const order = sequence++;
          process.stdout.write(JSON.stringify({
            id: req.id,
            kind: req.kind,
            ok: true,
            data: { order, overlap, requested: req.params.index },
          }) + "\\n");
          active = false;
        });
      `,
    ]);

    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          client.call<{ order: number; overlap: boolean; requested: number }>(
            "burst",
            { index },
          ),
        ),
      );

      expect(results.map((result) => result.order)).toEqual(
        Array.from({ length: 100 }, (_, index) => index),
      );
      expect(results.map((result) => result.requested)).toEqual(
        Array.from({ length: 100 }, (_, index) => index),
      );
      expect(results.every((result) => result.overlap === false)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("restarts the child process for the queued call after an active crash", async () => {
    const client = new StdioSidecarClient(process.execPath, [
      "-e",
      `
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const req = JSON.parse(line);
          if (req.kind === "crash") process.exit(7);
          process.stdout.write(JSON.stringify({
            id: req.id,
            kind: req.kind,
            ok: true,
            data: { kind: req.kind },
          }) + "\\n");
        });
      `,
    ]);

    try {
      const [first, second] = await Promise.allSettled([
        client.call("crash", {}),
        client.call<{ kind: string }>("after-crash", {}),
      ]);

      expect(first.status).toBe("rejected");
      expect(second).toEqual({
        status: "fulfilled",
        value: { kind: "after-crash" },
      });
    } finally {
      await client.close();
    }
  });

  it.each([
    ["wrong id", "wrong-id"],
    ["wrong kind", "wrong-kind"],
    ["malformed JSON", "malformed"],
  ])("poisons and replaces a generation after %s", async (_name, mode) => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-sidecar-protocol-"));
    const firstGenerationMarker = join(directory, "first-generation.txt");
    const client = new StdioSidecarClient(process.execPath, [
      "-e",
      `
        const fs = require("node:fs");
        const readline = require("node:readline");
        const marker = ${JSON.stringify(firstGenerationMarker)};
        const mode = ${JSON.stringify(mode)};
        readline.createInterface({ input: process.stdin }).on("line", (line) => {
          const req = JSON.parse(line);
          if (!fs.existsSync(marker)) {
            fs.writeFileSync(marker, String(process.pid));
            if (mode === "malformed") {
              process.stdout.write("{not-json\\n");
              return;
            }
            process.stdout.write(JSON.stringify({
              id: mode === "wrong-id" ? req.id + 1 : req.id,
              kind: mode === "wrong-kind" ? "stale-operation" : req.kind,
              ok: true,
              data: { generation: "poisoned" },
            }) + "\\n");
            return;
          }
          process.stdout.write(JSON.stringify({
            id: req.id,
            kind: req.kind,
            ok: true,
            data: { generation: "replacement", pid: process.pid },
          }) + "\\n");
        });
      `,
    ]);

    try {
      await expect(client.call("first", {})).rejects.toMatchObject({
        name: "SidecarProtocolError",
      });
      await expect(client.call("second", {})).resolves.toMatchObject({
        generation: "replacement",
      });
    } finally {
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retires a timed-out mutation before the next request can start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-sidecar-timeout-"));
    const firstGenerationMarker = join(directory, "first-generation.txt");
    const lateMutationMarker = join(directory, "late-mutation.txt");
    const client = new StdioSidecarClient(process.execPath, [
      "-e",
      `
        const fs = require("node:fs");
        const readline = require("node:readline");
        const first = ${JSON.stringify(firstGenerationMarker)};
        const late = ${JSON.stringify(lateMutationMarker)};
        readline.createInterface({ input: process.stdin }).on("line", (line) => {
          const req = JSON.parse(line);
          if (!fs.existsSync(first)) {
            fs.writeFileSync(first, String(process.pid));
            setTimeout(() => {
              fs.writeFileSync(late, "late");
              process.stdout.write(JSON.stringify({
                id: req.id,
                kind: req.kind,
                ok: true,
                data: { generation: "late" },
              }) + "\\n");
            }, 200);
            return;
          }
          process.stdout.write(JSON.stringify({
            id: req.id,
            kind: req.kind,
            ok: true,
            data: { generation: "replacement" },
          }) + "\\n");
        });
      `,
    ]);

    try {
      await expect(
        client.call(
          "mutate",
          {},
          {
            timeoutMs: 30,
            cancellationDelivery: "outcome-ambiguous",
          },
        ),
      ).rejects.toMatchObject({
        name: "OperationOutcomeAmbiguousError",
        operation: "mutate",
        outcome_ambiguous: true,
      });
      await expect(client.call("after-timeout", {})).resolves.toEqual({
        generation: "replacement",
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(lateMutationMarker)).toBe(false);
    } finally {
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("contains descendants when the sidecar leader exits first", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "unicli-sidecar-leader-exit-"),
    );
    const lateMutationMarker = join(directory, "late-mutation.txt");
    const client = new StdioSidecarClient(process.execPath, [
      "-e",
      `
        const { spawn } = require("node:child_process");
        const readline = require("node:readline");
        readline.createInterface({ input: process.stdin }).once("line", () => {
          spawn(process.execPath, ["-e", ${JSON.stringify(
            `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(lateMutationMarker)}, "late"), 200)`,
          )}], { stdio: "inherit" });
          process.exit(0);
        });
      `,
    ]);

    try {
      const outcome = client.call(
        "mutate",
        {},
        {
          cancellationDelivery: "outcome-ambiguous",
        },
      );
      await expect(outcome).rejects.toMatchObject({
        name: "OperationOutcomeAmbiguousError",
        outcome_ambiguous: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(lateMutationMarker)).toBe(false);
    } finally {
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("poisons an idle generation that emits an unsolicited frame", async () => {
    const client = new StdioSidecarClient(process.execPath, [
      "-e",
      `
        const readline = require("node:readline");
        readline.createInterface({ input: process.stdin }).on("line", (line) => {
          const req = JSON.parse(line);
          process.stdout.write(JSON.stringify({
            id: req.id,
            kind: req.kind,
            ok: true,
            data: { pid: process.pid },
          }) + "\\n");
          setTimeout(() => process.stdout.write(JSON.stringify({
            id: req.id,
            kind: req.kind,
            ok: true,
            data: { unsolicited: true },
          }) + "\\n"), 5);
        });
      `,
    ]);

    try {
      const first = await client.call<{ pid: number }>("first", {});
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await client.call<{ pid: number }>("second", {});
      expect(second.pid).not.toBe(first.pid);
    } finally {
      await client.close();
    }
  });

  it("rejects oversized responses and preserves state after serialization failure", async () => {
    const client = new StdioSidecarClient(
      process.execPath,
      [
        "-e",
        `
          const readline = require("node:readline");
          readline.createInterface({ input: process.stdin }).on("line", () => {
            process.stdout.write("x".repeat(129) + "\\n");
          });
        `,
      ],
      { maxFrameBytes: 128 },
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    try {
      await expect(client.call("circular", circular)).rejects.toThrow(
        /circular/i,
      );
      await expect(client.call("oversized", {})).rejects.toThrow(
        "sidecar response exceeded 128 bytes",
      );
    } finally {
      await client.close();
    }
  });

  it("waits for idle descendant containment before close resolves", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-sidecar-close-"));
    const lateMutationMarker = join(directory, "late-mutation.txt");
    const client = new StdioSidecarClient(process.execPath, [
      "-e",
      `
        const { spawn } = require("node:child_process");
        const readline = require("node:readline");
        readline.createInterface({ input: process.stdin }).once("line", (line) => {
          const req = JSON.parse(line);
          spawn(process.execPath, ["-e", ${JSON.stringify(
            `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(lateMutationMarker)}, "late"), 200)`,
          )}], { stdio: "inherit" });
          process.stdout.write(JSON.stringify({
            id: req.id,
            kind: req.kind,
            ok: true,
            data: { ready: true },
          }) + "\\n");
        });
      `,
    ]);

    try {
      await expect(client.call("ready", {})).resolves.toEqual({ ready: true });
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(lateMutationMarker)).toBe(false);
    } finally {
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
