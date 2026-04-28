import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runPipeline } from "../../src/engine/yaml-runner.js";

const originalAllowLocal = process.env.UNICLI_ALLOW_LOCAL;
const originalRulesPath = process.env.UNICLI_PERMISSION_RULES_PATH;

describe("runtime resource deny rules", () => {
  let tmp: string;
  let server: Server;
  let baseUrl: string;
  let requests = 0;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-runtime-rules-"));
    requests = 0;
    process.env.UNICLI_ALLOW_LOCAL = "1";
    process.env.UNICLI_PERMISSION_RULES_PATH = join(
      tmp,
      "permission-rules.json",
    );
    server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("should not be reached");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("missing port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
    if (originalAllowLocal === undefined) delete process.env.UNICLI_ALLOW_LOCAL;
    else process.env.UNICLI_ALLOW_LOCAL = originalAllowLocal;
    if (originalRulesPath === undefined) {
      delete process.env.UNICLI_PERMISSION_RULES_PATH;
    } else {
      process.env.UNICLI_PERMISSION_RULES_PATH = originalRulesPath;
    }
  });

  it("blocks denied fetch_text domains before the request is sent", async () => {
    writeFileSync(
      process.env.UNICLI_PERMISSION_RULES_PATH!,
      JSON.stringify({
        schema_version: "1",
        rules: [
          {
            id: "deny-loopback-runtime",
            decision: "deny",
            match: {
              resources: { domains: ["127.0.0.1"] },
            },
            reason: "loopback network is blocked for this run",
          },
        ],
      }),
      "utf-8",
    );

    await expect(
      runPipeline(
        [{ fetch_text: { url: `${baseUrl}/secret` } }],
        { args: {}, source: "internal" },
        undefined,
        { site: "runtime-fixture" },
      ),
    ).rejects.toMatchObject({
      detail: {
        action: "fetch_text",
        errorType: "permission_denied",
        retryable: false,
      },
    });
    expect(requests).toBe(0);
  });

  it("blocks denied download paths before writing a file", async () => {
    const deniedDir = join(tmp, "private");
    writeFileSync(
      process.env.UNICLI_PERMISSION_RULES_PATH!,
      JSON.stringify({
        schema_version: "1",
        rules: [
          {
            id: "deny-private-downloads",
            decision: "deny",
            match: {
              resources: { paths: [deniedDir] },
            },
            reason: "download target is blocked",
          },
        ],
      }),
      "utf-8",
    );

    await expect(
      runPipeline(
        [
          {
            download: {
              url: `${baseUrl}/file.txt`,
              dir: deniedDir,
              filename: "file.txt",
            },
          },
        ],
        { args: {}, source: "internal" },
        undefined,
        { site: "runtime-fixture" },
      ),
    ).rejects.toMatchObject({
      detail: {
        action: "download",
        errorType: "permission_denied",
        retryable: false,
      },
    });
    expect(requests).toBe(0);
    expect(existsSync(deniedDir)).toBe(false);
  });
});
