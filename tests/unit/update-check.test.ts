import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPDATE_CHECK_TTL_MS,
  UPDATE_REGISTRY_URL,
  checkForUpdates,
  isNewer,
  isValidVersion,
} from "../../src/engine/update-check.js";
import { refreshUpdateCache } from "../../src/engine/update-check-worker.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unicli-update-check-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("update version contract", () => {
  it("uses the encoded scoped package endpoint", () => {
    expect(UPDATE_REGISTRY_URL).toBe(
      "https://registry.npmjs.org/%40zenalexa%2Funicli/latest",
    );
  });

  it("compares major, minor, patch, and prerelease precedence", () => {
    expect(isNewer("1.0.0", "0.205.0")).toBe(true);
    expect(isNewer("0.206.0", "0.205.0")).toBe(true);
    expect(isNewer("0.205.1", "0.205.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-1", "1.0.0-alpha")).toBe(false);
    expect(isNewer("0.205.0", "0.205.0")).toBe(false);
    expect(isNewer("0.204.0", "0.205.0")).toBe(false);
  });

  it("rejects partial and malformed versions instead of guessing", () => {
    expect(isValidVersion("1.0.0")).toBe(true);
    expect(isValidVersion("1.0.0-beta.2+build.1")).toBe(true);
    expect(isValidVersion("1.0")).toBe(false);
    expect(isValidVersion("01.0.0")).toBe(false);
    expect(isValidVersion("1.0.0-01")).toBe(false);
    expect(isNewer("1.0", "0.205.0")).toBe(false);
  });
});

describe("foreground update check", () => {
  it("honors explicit disable controls", () => {
    expect(
      checkForUpdates({
        ...process.env,
        NO_UPDATE_NOTIFIER: "1",
        UNICLI_UPDATE_CHECK_FORCE: "1",
      }),
    ).toBe("disabled");
  });

  it("reads a fresh cache without launching a worker", () => {
    const cachePath = join(root, "update-check.json");
    writeFileSync(
      cachePath,
      JSON.stringify({ latest: "0.0.1", checkedAt: Date.now() }),
    );
    expect(
      checkForUpdates({
        ...process.env,
        UNICLI_UPDATE_CHECK_FORCE: "1",
        UNICLI_UPDATE_CHECK_CACHE_PATH: cachePath,
        UNICLI_UPDATE_CHECK_WORKER_PATH: join(root, "missing-worker.js"),
      }),
    ).toBe("fresh");
  });

  it("launches a detached worker for stale cache data", () => {
    const cachePath = join(root, "update-check.json");
    const workerPath = join(root, "worker.mjs");
    writeFileSync(
      cachePath,
      JSON.stringify({
        latest: "0.0.1",
        checkedAt: Date.now() - UPDATE_CHECK_TTL_MS - 1,
      }),
    );
    writeFileSync(workerPath, "process.exit(0);\n");

    expect(
      checkForUpdates({
        ...process.env,
        UNICLI_UPDATE_CHECK_FORCE: "1",
        UNICLI_UPDATE_CHECK_CACHE_PATH: cachePath,
        UNICLI_UPDATE_CHECK_WORKER_PATH: workerPath,
      }),
    ).toBe("refresh-started");
  });

  it("reports a missing compiled worker as a typed status", () => {
    expect(
      checkForUpdates({
        ...process.env,
        UNICLI_UPDATE_CHECK_FORCE: "1",
        UNICLI_UPDATE_CHECK_CACHE_PATH: join(root, "missing-cache.json"),
        UNICLI_UPDATE_CHECK_WORKER_PATH: join(root, "missing-worker.js"),
      }),
    ).toBe("worker-missing");
  });
});

describe("detached update worker", () => {
  it("writes validated scoped metadata atomically with owner-only POSIX modes", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "9.8.7" }));
    });
    const registryUrl = await listen(server);
    const cachePath = join(root, "state", "update-check.json");
    try {
      const result = await refreshUpdateCache({
        registryUrl,
        cachePath,
        timeoutMs: 1000,
        now: () => 123456,
      });
      expect(result).toEqual({ latest: "9.8.7", checkedAt: 123456 });
      expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual(result);
      if (process.platform !== "win32") {
        expect(lstatSync(join(root, "state")).mode & 0o777).toBe(0o700);
        expect(lstatSync(cachePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      await close(server);
    }
  });

  it("does not replace a valid cache with malformed registry data", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "latest" }));
    });
    const registryUrl = await listen(server);
    const cachePath = join(root, "update-check.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ latest: "1.2.3", checkedAt: 100 }),
    );
    if (process.platform !== "win32") chmodSync(cachePath, 0o600);
    try {
      await expect(
        refreshUpdateCache({ registryUrl, cachePath, timeoutMs: 1000 }),
      ).rejects.toThrow("no valid semantic version");
      expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({
        latest: "1.2.3",
        checkedAt: 100,
      });
    } finally {
      await close(server);
    }
  });
});
