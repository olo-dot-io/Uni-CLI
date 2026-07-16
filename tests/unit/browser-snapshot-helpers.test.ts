import { describe, expect, it, vi } from "vitest";

import { snapshotWithFingerprint } from "../../src/browser/snapshot-helpers.js";
import { FINGERPRINT_PERSIST_JS } from "../../src/browser/snapshot-identity.js";
import type { IPage } from "../../src/types.js";

describe("snapshotWithFingerprint", () => {
  it("returns a snapshot only after persisting its ref fingerprint", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce("[1]<button>Continue</button>")
      .mockResolvedValueOnce(123);

    await expect(
      snapshotWithFingerprint({ evaluate } as unknown as IPage, {
        interactive: true,
      }),
    ).resolves.toBe("[1]<button>Continue</button>");
    expect(evaluate).toHaveBeenLastCalledWith(
      FINGERPRINT_PERSIST_JS,
      undefined,
    );
  });

  it("rejects a snapshot whose fingerprint could not be persisted", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce("[1]<button>Continue</button>")
      .mockRejectedValueOnce(new Error("renderer navigated"));

    await expect(
      snapshotWithFingerprint({ evaluate } as unknown as IPage),
    ).rejects.toThrow("renderer navigated");
  });

  it("does not persist a fingerprint after a cancelled snapshot evaluation finishes late", async () => {
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
