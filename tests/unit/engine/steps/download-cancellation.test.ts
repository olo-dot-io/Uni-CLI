import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stepDownload } from "../../../../src/engine/steps/download.js";
import { httpDownload } from "../../../../src/engine/download.js";

let server: Server | undefined;
let output = "";
let previousAllowLocal: string | undefined;

beforeEach(() => {
  previousAllowLocal = process.env.UNICLI_ALLOW_LOCAL;
  process.env.UNICLI_ALLOW_LOCAL = "1";
  output = mkdtempSync(join(tmpdir(), "unicli-download-cancel-"));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
  rmSync(output, { recursive: true, force: true });
  if (previousAllowLocal === undefined) {
    delete process.env.UNICLI_ALLOW_LOCAL;
  } else {
    process.env.UNICLI_ALLOW_LOCAL = previousAllowLocal;
  }
});

describe("download cancellation", () => {
  it("stops a slow HTTP stream and never publishes a partial artifact", async () => {
    server = createServer((_request, response) => {
      response.setHeader("content-type", "application/pdf");
      response.write("%PDF-1.7\n");
      const interval = setInterval(() => response.write("x".repeat(4096)), 20);
      response.on("close", () => clearInterval(interval));
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a port");
    }

    const controller = new AbortController();
    const reason = new Error("download-cancelled");
    const startedAt = Date.now();
    const pending = stepDownload(
      {
        data: null,
        args: {},
        vars: {},
        signal: controller.signal,
      },
      {
        url: `http://127.0.0.1:${address.port}/slow.pdf`,
        dir: output,
        filename: "slow.pdf",
        type: "document",
      },
      0,
    );
    setTimeout(() => controller.abort(reason), 50);

    await expect(pending).rejects.toBe(reason);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(readdirSync(output)).toEqual([]);
  });

  it("preserves the public legacy headers and signal arguments", async () => {
    let authorization = "";
    server = createServer((request, response) => {
      authorization = request.headers.authorization ?? "";
      response.write("start");
      const interval = setInterval(() => response.write("x".repeat(4096)), 20);
      response.on("close", () => clearInterval(interval));
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a port");
    }

    const controller = new AbortController();
    const reason = new Error("legacy-download-cancelled");
    const destination = join(output, "legacy.bin");
    const pending = httpDownload(
      `http://127.0.0.1:${address.port}/legacy`,
      destination,
      { Authorization: "Bearer legacy" },
      controller.signal,
    );
    setTimeout(() => controller.abort(reason), 50);

    await expect(pending).rejects.toBe(reason);
    expect(authorization).toBe("Bearer legacy");
    expect(readdirSync(output)).toEqual([]);
  });
});
