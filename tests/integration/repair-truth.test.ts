import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEnvelope } from "../../src/output/envelope.js";
import { validateEnvelope } from "../../src/output/envelope.js";

let server: Server;
let port = 0;
let home = "";

function adapter(name: string, path: string): string {
  return `site: repair-truth-fixture
name: ${name}
description: Repair truth integration fixture
type: web-api
domain: 127.0.0.1
strategy: public
pipeline:
  - fetch:
      url: http://127.0.0.1:${port}/${path}
columns: [value]
capabilities: [http.fetch]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: true
quarantineReason: repair verifier must use a child-only override
schema_version: v2
`;
}

function runRepair(command: string): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      [
        "src/main.ts",
        "-f",
        "json",
        "repair",
        "repair-truth-fixture",
        command,
        "--timeout",
        "10",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          UNICLI_ALLOW_LOCAL: "1",
          UNICLI_SKIP_UPDATE_CHECK: "1",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function envelopeFrom(text: string): AgentEnvelope {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`missing envelope: ${text}`);
  const envelope = JSON.parse(text.slice(start, end + 1)) as AgentEnvelope;
  validateEnvelope(envelope);
  return envelope;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/ok") {
      response.end(JSON.stringify([{ value: "ok" }]));
      return;
    }
    response.statusCode = 503;
    response.end(JSON.stringify({ error: "upstream unavailable" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("repair integration server has no port");
  }
  port = address.port;

  home = mkdtempSync(join(tmpdir(), "unicli-repair-truth-"));
  const adapterDir = join(home, ".unicli", "adapters", "repair-truth-fixture");
  mkdirSync(adapterDir, { recursive: true });
  writeFileSync(join(adapterDir, "ping.yaml"), adapter("ping", "ok"));
  writeFileSync(join(adapterDir, "broken.yaml"), adapter("broken", "fail"));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  rmSync(home, { recursive: true, force: true });
});

describe("repair envelope and process truth", () => {
  it("returns ok=true and exit zero only after the target succeeds", async () => {
    const result = await runRepair("ping");
    expect(result.exitCode).toBe(0);
    const envelope = envelopeFrom(result.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      command: "repair.verify",
      data: {
        mode: "verification",
        verified: true,
        oracle: { exit_code: 0, envelope_ok: true },
      },
    });
  });

  it("propagates the target failure envelope and nonzero exit", async () => {
    const result = await runRepair("broken");
    expect(result.exitCode).toBe(1);
    const envelope = envelopeFrom(result.stderr);
    expect(envelope).toMatchObject({
      ok: false,
      command: "repair.verify",
      error: {
        code: "upstream_error",
        exit_code: 1,
      },
    });
    if (!envelope.ok) {
      expect(envelope.error.adapter_path).toContain(
        "/.unicli/adapters/repair-truth-fixture/broken.yaml",
      );
    }
  });
});
