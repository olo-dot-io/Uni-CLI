import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeFileTransactionally } from "../../src/engine/transactional-file.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("transactional file publication", () => {
  it("preserves the prior destination and removes staging on in-flight cancellation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-transactional-file-"));
    temporaryDirectories.push(directory);
    const destination = join(directory, "artifact.bin");
    writeFileSync(destination, "prior-artifact");
    const controller = new AbortController();
    const cancellation = new Error("cancel artifact write");
    const data = Buffer.alloc(64 * 1024 * 1024, 0x61);

    const publication = writeFileTransactionally(destination, data, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(cancellation), 0);

    await expect(publication).rejects.toBe(cancellation);
    expect(readFileSync(destination, "utf8")).toBe("prior-artifact");
    expect(readdirSync(directory)).toEqual(["artifact.bin"]);
  });
});
