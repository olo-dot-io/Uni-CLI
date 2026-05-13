import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  closeSync,
  openSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inferArtifactValidators,
  validateArtifactRows,
} from "../../src/engine/artifact-validation.js";
import { buildCommandContract } from "../../src/core/command-contract.js";
import {
  AdapterType,
  type AdapterCommand,
  type AdapterManifest,
} from "../../src/types.js";

function downloadCommand(): AdapterCommand {
  return {
    name: "download",
    description: "Download a file",
    adapter_path: "src/adapters/example/download.yaml",
    pipeline: [{ download: { url: "https://example.com/file.bin" } }],
  };
}

describe("artifact validation", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-artifact-validation-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("infers mandatory validators from artifact-producing pipeline steps", () => {
    expect(inferArtifactValidators(downloadCommand())).toEqual([
      {
        kind: "download.status_success",
        source: "pipeline.download",
        required: true,
      },
      { kind: "file.exists", source: "pipeline.download", required: true },
      { kind: "file.non_empty", source: "pipeline.download", required: true },
    ]);
    expect(
      inferArtifactValidators({
        name: "render",
        execArgs: ["--export", "scene.png"],
      }),
    ).toEqual([]);
  });

  it("validates real downloaded artifact files instead of trusting exit code", async () => {
    const artifact = join(tmp, "file.bin");
    writeFileSync(artifact, "bytes");

    await expect(
      validateArtifactRows(downloadCommand(), [
        { _download: { status: "success", path: artifact, size: 5 } },
      ]),
    ).resolves.toMatchObject({
      ok: true,
      checked_files: 1,
      issues: [],
    });
  });

  it("fails closed on missing and empty artifacts", async () => {
    const empty = join(tmp, "empty.bin");
    closeSync(openSync(empty, "w"));

    const result = await validateArtifactRows(downloadCommand(), [
      { _download: { status: "success", path: join(tmp, "missing.bin") } },
      { _download: { status: "success", path: empty } },
      { _download: { status: "failed", error: "HTTP 500" } },
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "artifact_missing",
      "artifact_empty",
      "download_failed",
    ]);
  });

  it("validates write_temp artifact paths with real filesystem probes", async () => {
    const artifact = join(tmp, "render.png");
    writeFileSync(artifact, "png");

    await expect(
      validateArtifactRows(
        {
          name: "render",
          pipeline: [
            { write_temp: { filename: "render.png", content: "png" } },
          ],
        },
        [{ _temp: { render_png: artifact } }],
      ),
    ).resolves.toMatchObject({
      ok: true,
      checked_files: 1,
      issues: [],
    });
  });

  it("fails closed when non-download artifact validators have no file path", async () => {
    const result = await validateArtifactRows(
      {
        name: "render",
        pipeline: [{ write_temp: { filename: "render.png", content: "png" } }],
      },
      [{ ok: true }],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: "missing_artifact_path",
      message: "row has no artifact path metadata",
      row_index: 0,
    });
  });

  it("fails closed when artifact-producing commands return no rows", async () => {
    const result = await validateArtifactRows(downloadCommand(), []);

    expect(result.ok).toBe(false);
    expect(result.checked_files).toBe(0);
    expect(result.issues).toContainEqual({
      code: "missing_artifact_path",
      message: "artifact-producing command produced no artifact rows",
      row_index: -1,
    });
  });

  it("projects artifact validators into CommandContract", () => {
    const adapter: AdapterManifest = {
      name: "example",
      type: AdapterType.WEB_API,
      domain: "example.com",
      commands: { download: downloadCommand() },
    };

    const contract = buildCommandContract({
      adapter,
      commandName: "download",
      command: adapter.commands.download,
    });

    expect(contract.artifacts).toEqual({
      produces_files: true,
      validators: ["download.status_success", "file.exists", "file.non_empty"],
    });
  });

  it("does not report local file access as produced artifacts", () => {
    const adapter: AdapterManifest = {
      name: "desktop-info",
      type: AdapterType.DESKTOP,
      commands: {
        info: {
          name: "info",
          description: "Read local project metadata",
          execArgs: ["--info", "scene.blend"],
        },
      },
    };

    const contract = buildCommandContract({
      adapter,
      commandName: "info",
      command: adapter.commands.info,
    });

    expect(contract.artifacts).toEqual({
      produces_files: false,
      validators: [],
    });
  });
});
