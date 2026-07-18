import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  OperationOutcomeAmbiguousError,
  runContainedProcess,
} from "../../../src/transport/contained-process.js";

describe("runContainedProcess", () => {
  it("treats a successful child exit as authoritative when stdin closes early", async () => {
    const result = await runContainedProcess(
      process.execPath,
      ["-e", "process.exit(0)"],
      { input: "x".repeat(16 * 1024 * 1024) },
    );

    expect(result).toMatchObject({ exitCode: 0, signal: null });
  });

  it("kills descendant work and awaits containment before returning cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "unicli-process-containment-"));
    const marker = join(root, "late-mutation.txt");
    const childScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 250)`;
    const parentScript = [
      `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" })`,
      "setTimeout(() => {}, 10000)",
    ].join(";");
    const controller = new AbortController();
    const cancellation = new Error("cancel process tree");

    try {
      const execution = runContainedProcess(
        process.execPath,
        ["-e", parentScript],
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(cancellation), 50);
      await expect(execution).rejects.toBe(cancellation);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks dispatched launcher cancellation as outcome-ambiguous", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancel launch delivery");
    const execution = runContainedProcess(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      {
        signal: controller.signal,
        cancellationDelivery: "outcome-ambiguous",
      },
    );
    setTimeout(() => controller.abort(cancellation), 25);

    await expect(execution).rejects.toMatchObject({
      name: "OperationOutcomeAmbiguousError",
      outcome_ambiguous: true,
      cancellationReason: cancellation,
    });
    await expect(execution).rejects.toBeInstanceOf(
      OperationOutcomeAmbiguousError,
    );
  });

  it("marks a timed-out dispatched delivery as outcome-ambiguous", async () => {
    const execution = runContainedProcess(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      {
        timeoutMs: 100,
        cancellationDelivery: "outcome-ambiguous",
      },
    );

    await expect(execution).rejects.toMatchObject({
      name: "OperationOutcomeAmbiguousError",
      outcome_ambiguous: true,
      cancellationReason: expect.objectContaining({ name: "TimeoutError" }),
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves outcome ambiguity when process-group containment fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "unicli-process-uncontained-"));
      const marker = join(root, "committed.txt");
      const originalKill = process.kill;
      // REASON: process.kill is the external POSIX containment boundary; the real child process and failure path remain owned production code.
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementation((pid, signal) => {
          if (pid < 0) {
            const error = new Error(
              "simulated process-group permission failure",
            ) as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          }
          return originalKill(pid, signal);
        });
      const script = [
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "committed")`,
        "setTimeout(() => {}, 10000)",
      ].join(";");

      try {
        const execution = runContainedProcess(
          process.execPath,
          ["-e", script],
          {
            timeoutMs: 100,
            cancellationDelivery: "outcome-ambiguous",
          },
        );

        await expect(execution).rejects.toMatchObject({
          name: "ProcessContainmentAmbiguousError",
          outcome_ambiguous: true,
          retryable: false,
          cancellationReason: expect.objectContaining({ name: "TimeoutError" }),
          cause: expect.objectContaining({ name: "AggregateError" }),
        });
        await expect(readFile(marker, "utf8")).resolves.toBe("committed");
      } finally {
        kill.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
