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
    expect(evaluate).toHaveBeenLastCalledWith(FINGERPRINT_PERSIST_JS);
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
});
