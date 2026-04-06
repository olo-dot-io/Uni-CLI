import { describe, it, expect, vi, beforeEach } from "vitest";

describe("proxy", () => {
  beforeEach(() => {
    // Clear module cache so each test gets a fresh singleton
    vi.resetModules();
    delete process.env.http_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTPS_PROXY;
  });

  it("returns undefined when no proxy env vars are set", async () => {
    const { getProxyAgent } = await import("../../src/engine/proxy.js");
    expect(getProxyAgent()).toBeUndefined();
  });

  it("returns agent when http_proxy is set", async () => {
    process.env.http_proxy = "http://proxy.example.com:8080";
    const { getProxyAgent } = await import("../../src/engine/proxy.js");
    expect(getProxyAgent()).toBeDefined();
  });

  it("returns agent when HTTPS_PROXY is set", async () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    const { getProxyAgent } = await import("../../src/engine/proxy.js");
    expect(getProxyAgent()).toBeDefined();
  });

  it("hasProxyConfig returns false when no env vars", async () => {
    const { hasProxyConfig } = await import("../../src/engine/proxy.js");
    expect(hasProxyConfig()).toBe(false);
  });

  it("hasProxyConfig returns true when HTTP_PROXY is set", async () => {
    process.env.HTTP_PROXY = "http://proxy:3128";
    const { hasProxyConfig } = await import("../../src/engine/proxy.js");
    expect(hasProxyConfig()).toBe(true);
  });

  it("hasProxyConfig returns true when https_proxy is set", async () => {
    process.env.https_proxy = "http://proxy:3128";
    const { hasProxyConfig } = await import("../../src/engine/proxy.js");
    expect(hasProxyConfig()).toBe(true);
  });

  it("reuses the same agent instance (singleton)", async () => {
    process.env.http_proxy = "http://proxy.example.com:8080";
    const { getProxyAgent } = await import("../../src/engine/proxy.js");
    const a1 = getProxyAgent();
    const a2 = getProxyAgent();
    expect(a1).toBe(a2);
  });
});
