import { afterEach, describe, expect, it, vi } from "vitest";

import { clearBuckets, waitForToken } from "../../src/engine/rate-limiter.js";

afterEach(() => {
  clearBuckets();
  vi.useRealTimers();
});

describe("per-domain rate limiter", () => {
  it("serializes concurrent callers so each waits for its own token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const resolved: number[] = [];

    const callers = [1, 2, 3].map((id) =>
      waitForToken("EXAMPLE.COM", 1).then(() => resolved.push(id)),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toEqual([1]);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(resolved).toEqual([1]);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toEqual([1, 2]);

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(callers);
    expect(resolved).toEqual([1, 2, 3]);
  });

  it("rejects invalid limits without creating a timer", async () => {
    vi.useFakeTimers();

    await expect(waitForToken("", 60)).rejects.toThrow("non-empty string");
    await expect(waitForToken("example.com", 0)).rejects.toThrow(
      "integer from 1 to 60000",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the strictest policy when callers disagree on one domain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const resolved: string[] = [];

    await waitForToken("example.com", 1);
    const looserCaller = waitForToken("example.com", 60_000).then(() =>
      resolved.push("looser"),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toEqual([]);
    await vi.advanceTimersByTimeAsync(59_999);
    await looserCaller;
    expect(resolved).toEqual(["looser"]);
  });
});
