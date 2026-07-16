import { describe, expect, it, vi } from "vitest";

import { snapshotWithFingerprint } from "../../src/browser/snapshot-helpers.js";
import type { IPage } from "../../src/types.js";

describe("snapshotWithFingerprint", () => {
  it("installs the snapshot and ref registries in one renderer evaluation", async () => {
    const evaluate = vi.fn().mockResolvedValue("[1]<button>Continue</button>");

    await expect(
      snapshotWithFingerprint({ evaluate } as unknown as IPage, {
        interactive: true,
      }),
    ).resolves.toBe("[1]<button>Continue</button>");
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(expect.any(String), undefined);
    const script = evaluate.mock.calls[0]?.[0] as string;
    expect(script).toContain("window.__unicli_ref_identity = identity");
    expect(script).toContain("window.__unicli_ref_nodes = nodes");
    expect(script).toMatch(/const SNAPSHOT_ID = "[0-9a-f-]{36}"/);
  });

  it("rejects when the atomic snapshot evaluation fails", async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error("renderer navigated"));

    await expect(
      snapshotWithFingerprint({ evaluate } as unknown as IPage),
    ).rejects.toThrow("renderer navigated");
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("does not return a snapshot after a cancelled evaluation finishes late", async () => {
    let finishEvaluation!: (value: unknown) => void;
    const evaluate = vi.fn(
      (_script: string, _signal?: AbortSignal) =>
        new Promise<unknown>((resolve) => {
          finishEvaluation = resolve;
        }),
    );
    const controller = new AbortController();
    const operation = snapshotWithFingerprint(
      { evaluate } as unknown as IPage,
      undefined,
      controller.signal,
    );

    const cancellation = new Error("cancel snapshot");
    controller.abort(cancellation);
    finishEvaluation("[1]<button>Continue</button>");

    await expect(operation).rejects.toBe(cancellation);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(
      expect.any(String),
      controller.signal,
    );
  });
});
