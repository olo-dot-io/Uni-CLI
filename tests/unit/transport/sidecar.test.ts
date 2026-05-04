import { describe, expect, it } from "vitest";

import { StdioSidecarClient } from "../../../src/transport/sidecar.js";

describe("StdioSidecarClient", () => {
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
});
