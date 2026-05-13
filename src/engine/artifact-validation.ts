/**
 * @owner Uni-CLI Engine
 * @does Infers and executes artifact validators for file-producing commands.
 * @needs AdapterCommand pipeline metadata and command result rows.
 * @feeds CommandContract artifacts and adapter/backend validation gates.
 * @breaks Artifact-producing adapters when exit code is treated as sufficient proof.
 */

import { stat } from "node:fs/promises";
import type { AdapterCommand, PipelineStep } from "../types.js";

export type ArtifactValidatorKind =
  | "file.exists"
  | "file.non_empty"
  | "download.status_success"
  | "desktop.artifact_probe";

export interface ArtifactValidator {
  kind: ArtifactValidatorKind;
  source: "pipeline.download" | "pipeline.write_temp" | "desktop.exec";
  required: true;
}

export interface ArtifactValidationIssue {
  code:
    | "missing_download_result"
    | "download_failed"
    | "missing_artifact_path"
    | "artifact_missing"
    | "artifact_empty"
    | "unsupported_artifact_validator";
  message: string;
  row_index: number;
  path?: string;
}

export interface ArtifactValidationResult {
  ok: boolean;
  validators: ArtifactValidator[];
  checked_files: number;
  issues: ArtifactValidationIssue[];
}

interface DownloadLike {
  status?: unknown;
  path?: unknown;
  size?: unknown;
  error?: unknown;
}

interface ArtifactLike {
  path?: unknown;
}

function pipelineAction(step: PipelineStep): string | undefined {
  return Object.keys(step)[0];
}

function hasPipelineAction(command: AdapterCommand, action: string): boolean {
  return (command.pipeline ?? []).some(
    (step) => pipelineAction(step) === action,
  );
}

function uniqueValidators(
  validators: ArtifactValidator[],
): ArtifactValidator[] {
  const seen = new Set<string>();
  return validators.filter((validator) => {
    const key = `${validator.kind}:${validator.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function inferArtifactValidators(
  command: AdapterCommand,
): ArtifactValidator[] {
  const validators: ArtifactValidator[] = [];

  if (hasPipelineAction(command, "download")) {
    validators.push(
      {
        kind: "download.status_success",
        source: "pipeline.download",
        required: true,
      },
      { kind: "file.exists", source: "pipeline.download", required: true },
      { kind: "file.non_empty", source: "pipeline.download", required: true },
    );
  }

  if (hasPipelineAction(command, "write_temp")) {
    validators.push(
      { kind: "file.exists", source: "pipeline.write_temp", required: true },
      { kind: "file.non_empty", source: "pipeline.write_temp", required: true },
    );
  }

  return uniqueValidators(validators);
}

function recordIssue(
  issues: ArtifactValidationIssue[],
  issue: ArtifactValidationIssue,
): void {
  issues.push(issue);
}

function downloadFromRow(row: unknown): DownloadLike | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const value = (row as Record<string, unknown>)._download;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as DownloadLike;
}

async function validateDownloadRow(
  row: unknown,
  rowIndex: number,
  issues: ArtifactValidationIssue[],
): Promise<number> {
  const download = downloadFromRow(row);
  if (!download) {
    recordIssue(issues, {
      code: "missing_download_result",
      message: "row has no _download artifact metadata",
      row_index: rowIndex,
    });
    return 0;
  }

  if (download.status !== "success" && download.status !== "skipped") {
    recordIssue(issues, {
      code: "download_failed",
      message:
        typeof download.error === "string"
          ? download.error
          : "download artifact did not succeed",
      row_index: rowIndex,
    });
    return 0;
  }

  if (typeof download.path !== "string" || download.path.length === 0) {
    recordIssue(issues, {
      code: "missing_artifact_path",
      message: "download artifact has no path",
      row_index: rowIndex,
    });
    return 0;
  }

  return validateFilePath(download.path, rowIndex, issues);
}

async function validateFilePath(
  path: string,
  rowIndex: number,
  issues: ArtifactValidationIssue[],
): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      recordIssue(issues, {
        code: "artifact_missing",
        message: "artifact path is not a file",
        row_index: rowIndex,
        path,
      });
      return 0;
    }
    if (info.size <= 0) {
      recordIssue(issues, {
        code: "artifact_empty",
        message: "artifact file is empty",
        row_index: rowIndex,
        path,
      });
      return 1;
    }
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordIssue(issues, {
      code: "artifact_missing",
      message: `artifact path does not exist: ${message}`,
      row_index: rowIndex,
      path,
    });
    return 0;
  }
}

function artifactPathsFromRow(row: unknown): string[] {
  if (!row || typeof row !== "object" || Array.isArray(row)) return [];
  const record = row as Record<string, unknown>;
  const paths: string[] = [];

  const artifact = record._artifact;
  if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
    const path = (artifact as ArtifactLike).path;
    if (typeof path === "string" && path.length > 0) paths.push(path);
  }

  const artifacts = record._artifacts;
  if (Array.isArray(artifacts)) {
    for (const item of artifacts) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const path = (item as ArtifactLike).path;
      if (typeof path === "string" && path.length > 0) paths.push(path);
    }
  }

  const temp = record._temp ?? record.temp;
  if (temp && typeof temp === "object" && !Array.isArray(temp)) {
    for (const value of Object.values(temp)) {
      if (typeof value === "string" && value.length > 0) paths.push(value);
    }
  }

  if (typeof record.path === "string" && record.path.length > 0) {
    paths.push(record.path);
  }

  return [...new Set(paths)];
}

async function validateArtifactPathRow(
  row: unknown,
  rowIndex: number,
  issues: ArtifactValidationIssue[],
): Promise<number> {
  const paths = artifactPathsFromRow(row);
  if (paths.length === 0) {
    recordIssue(issues, {
      code: "missing_artifact_path",
      message: "row has no artifact path metadata",
      row_index: rowIndex,
    });
    return 0;
  }

  let checked = 0;
  for (const path of paths) {
    checked += await validateFilePath(path, rowIndex, issues);
  }
  return checked;
}

export async function validateArtifactRows(
  command: AdapterCommand,
  rows: unknown[],
): Promise<ArtifactValidationResult> {
  const validators = inferArtifactValidators(command);
  const issues: ArtifactValidationIssue[] = [];
  let checkedFiles = 0;

  const validatesDownloads = validators.some((validator) => {
    return validator.source === "pipeline.download";
  });
  if (validatesDownloads) {
    for (const [index, row] of rows.entries()) {
      checkedFiles += await validateDownloadRow(row, index, issues);
    }
  }

  const validatesGenericArtifacts = validators.some((validator) => {
    return (
      validator.source === "pipeline.write_temp" ||
      validator.source === "desktop.exec"
    );
  });
  if (validatesGenericArtifacts) {
    for (const [index, row] of rows.entries()) {
      checkedFiles += await validateArtifactPathRow(row, index, issues);
    }
  }

  const unsupported = validators.filter((validator) => {
    return (
      validator.source !== "pipeline.download" &&
      validator.source !== "pipeline.write_temp" &&
      validator.source !== "desktop.exec"
    );
  });
  for (const validator of unsupported) {
    recordIssue(issues, {
      code: "unsupported_artifact_validator",
      message: `unsupported artifact validator source ${validator.source}`,
      row_index: -1,
    });
  }

  if (validators.length > 0 && checkedFiles === 0 && issues.length === 0) {
    recordIssue(issues, {
      code: "missing_artifact_path",
      message: "artifact-producing command produced no artifact rows",
      row_index: -1,
    });
  }

  return {
    ok: issues.length === 0,
    validators,
    checked_files: checkedFiles,
    issues,
  };
}
