import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import { requireInstagramCollectionInput } from "./collections.js";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
  };
}

describe("instagram collection agent-facing commands", () => {
  it("validates collection inputs before navigation", async () => {
    expect(requireInstagramCollectionInput(" Research ", "name")).toBe(
      "Research",
    );
    expect(() => requireInstagramCollectionInput("", "name")).toThrow(
      "cannot be empty",
    );
    const command = resolveCommand("instagram", "collection-create")?.command;
    const page = pageMock([]);
    await expect(command!.func!(page, { name: "" })).rejects.toThrow(
      "cannot be empty",
    );
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("creates Instagram saved-post collections", async () => {
    const command = resolveCommand("instagram", "collection-create")?.command;
    const page = pageMock([
      {
        ok: true,
        row: {
          status: "Created",
          collectionId: "123456",
          collectionName: "Research",
          mediaCount: 0,
        },
      },
    ]);
    await expect(command!.func!(page, { name: "Research" })).resolves.toEqual([
      {
        status: "Created",
        collectionId: "123456",
        collectionName: "Research",
        mediaCount: 0,
      },
    ]);
    expect(page.goto).toHaveBeenCalledWith("https://www.instagram.com");
    expect(String(page.evaluate.mock.calls[0][0])).toContain(
      "/api/v1/collections/create/",
    );
  });

  it("deletes Instagram saved-post collections", async () => {
    const command = resolveCommand("instagram", "collection-delete")?.command;
    const page = pageMock([
      {
        ok: true,
        row: {
          status: "Deleted",
          collectionId: "123456",
          collectionName: "Research",
        },
      },
    ]);
    await expect(command!.func!(page, { target: "Research" })).resolves.toEqual(
      [
        {
          status: "Deleted",
          collectionId: "123456",
          collectionName: "Research",
        },
      ],
    );
    expect(page.goto).toHaveBeenCalledWith("https://www.instagram.com");
    expect(String(page.evaluate.mock.calls[0][0])).toContain(
      "/api/v1/collections/list/",
    );
    expect(String(page.evaluate.mock.calls[0][0])).toContain(
      "/api/v1/collections/",
    );
  });

  it("propagates Instagram collection API failures", async () => {
    const command = resolveCommand("instagram", "collection-delete")?.command;
    const page = pageMock([
      { ok: false, error: "Collection not found: Research" },
    ]);
    await expect(command!.func!(page, { target: "Research" })).rejects.toThrow(
      "Collection not found",
    );
  });
});
