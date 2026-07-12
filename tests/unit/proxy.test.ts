import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  describeNetworkFailure,
  fetchWithProxy,
  hasProxyConfig,
  resolveProxyConfig,
} from "../../src/engine/proxy.js";
import { runPipeline } from "../../src/engine/executor.js";

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("proxy environment contract", () => {
  it("resolves protocol-specific proxies with HTTP and ALL fallbacks", () => {
    expect(
      resolveProxyConfig({
        HTTPS_PROXY: "http://secure-proxy:8080",
      }),
    ).toMatchObject({ httpsProxy: "http://secure-proxy:8080" });
    expect(
      resolveProxyConfig({
        HTTP_PROXY: "http://shared-proxy:8080",
      }),
    ).toMatchObject({
      httpProxy: "http://shared-proxy:8080",
      httpsProxy: "http://shared-proxy:8080",
    });
    expect(
      resolveProxyConfig({
        ALL_PROXY: "http://all-proxy:8080",
      }),
    ).toMatchObject({
      httpProxy: "http://all-proxy:8080",
      httpsProxy: "http://all-proxy:8080",
    });
  });

  it("preserves NO_PROXY and always appends loopback exclusions", () => {
    const env = { http_proxy: "http://proxy:3128", NO_PROXY: "internal.test" };
    expect(hasProxyConfig(env)).toBe(true);
    expect(resolveProxyConfig(env)).toEqual({
      httpProxy: "http://proxy:3128",
      httpsProxy: "http://proxy:3128",
      noProxy: "internal.test,127.0.0.1,localhost,::1",
    });
    expect(hasProxyConfig({})).toBe(false);
  });
});

describe("proxy fetch integration", () => {
  it("uses one Undici implementation for fetch and dispatcher", async () => {
    let requestTarget = "";
    const proxy = createServer((request, response) => {
      requestTarget = request.url ?? "";
      response.setHeader("content-type", "application/json");
      response.setHeader("connection", "close");
      response.end(JSON.stringify({ via: "proxy" }));
    });
    const proxyPort = await listen(proxy);

    const response = await fetchWithProxy(
      "http://upstream.invalid/items",
      {},
      { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
    );

    expect(await response.json()).toEqual({ via: "proxy" });
    expect(requestTarget).toBe("http://upstream.invalid/items");
  });

  it("routes direct public pipeline execution through the proxy boundary", async () => {
    let requestTarget = "";
    const proxy = createServer((request, response) => {
      requestTarget = request.url ?? "";
      response.setHeader("content-type", "application/json");
      response.setHeader("connection", "close");
      response.end(JSON.stringify({ via: "direct-engine-proxy" }));
    });
    const proxyPort = await listen(proxy);
    const previous = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;

    try {
      const result = await runPipeline(
        [{ fetch: { url: "http://upstream.invalid/direct-engine" } }],
        { args: {}, source: "internal" },
      );
      expect(result).toEqual([{ via: "direct-engine-proxy" }]);
      expect(requestTarget).toBe("http://upstream.invalid/direct-engine");
    } finally {
      if (previous === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = previous;
    }
  });

  it("reaches loopback directly even when the configured proxy is dead", async () => {
    const targetPort = await listen(
      createServer((_request, response) => response.end("direct")),
    );

    const response = await fetchWithProxy(
      `http://127.0.0.1:${targetPort}/health`,
      {},
      { HTTP_PROXY: "http://127.0.0.1:9" },
    );

    expect(await response.text()).toBe("direct");
  });

  it("retains nested failure codes for agent-readable diagnostics", () => {
    const cause = Object.assign(new Error("connect refused"), {
      code: "ECONNREFUSED",
    });
    expect(describeNetworkFailure(new Error("fetch failed", { cause }))).toBe(
      "fetch failed: connect refused (ECONNREFUSED)",
    );
  });
});
