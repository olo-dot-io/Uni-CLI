/**
 * @owner   src/compute/capture-reference.ts
 * @does    Persist compute capture packets as reusable local app-shot references for agent handoff.
 * @needs   node:crypto, cancellable node:fs/promises and child processes, src/compute/capture.ts
 * @feeds   src/commands/compute.ts, src/mcp/profiles/computer-use.ts, tests/unit/compute-capture-reference.test.ts
 * @breaks  Throws filesystem or cancellation errors and removes its unique unpublished directory when reference publication fails.
 * @invariants Reference markup always points at local files that were written before it is returned; cancellation cannot fall through to another clipboard provider.
 * @side-effects Writes metadata/content/image artifacts under ~/.unicli/app-shots or an explicit root.
 * @perf    Copies screenshot bytes once and does not duplicate image bytes into metadata JSON.
 * @concurrency Each save receives a unique id so repeated captures do not overwrite prior handoff artifacts.
 * @test    tests/unit/compute-capture-reference.test.ts
 * @stability beta
 * @since   0.223.0
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ComputeCapturePacket, ComputeCapturePart } from "./capture.js";
import { buildCaptureVisualTimeline } from "./visual-timeline.js";

export interface ComputeCaptureReferenceOptions {
  rootDir?: string;
  signal?: AbortSignal;
}

export interface ComputeCaptureReference {
  schema_version: 1;
  id: string;
  created_at: string;
  app?: string;
  markup: string;
  root: string;
  files: {
    metadata: string;
    content: string;
    image?: string;
  };
}

export interface ClipboardCopyOptions {
  platform?: NodeJS.Platform;
  run?: ClipboardCommandRunner;
  signal?: AbortSignal;
}

export type ClipboardCommandRunner = (
  command: string,
  args: string[],
  input: string,
  signal?: AbortSignal,
) => Promise<void>;

interface ReferenceEnvelope {
  schema_version: 1;
  reference: ComputeCaptureReference;
  packet: ComputeCapturePacket;
}

export async function saveComputeCaptureReference(
  packet: ComputeCapturePacket,
  options: ComputeCaptureReferenceOptions = {},
): Promise<ComputeCaptureReference> {
  options.signal?.throwIfAborted();
  const root = options.rootDir ?? defaultReferenceRoot();
  const id = referenceId(packet);
  const captureDir = join(root, id);
  await mkdir(captureDir, { recursive: true, mode: 0o700 });
  try {
    options.signal?.throwIfAborted();
    const imagePath = await writeImageEvidence(
      packet,
      captureDir,
      options.signal,
    );
    const contentPath = join(captureDir, "content.txt");
    await writeFile(contentPath, captureContent(packet, imagePath), {
      encoding: "utf-8",
      mode: 0o600,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.signal?.throwIfAborted();

    const metadataPath = join(captureDir, "packet.json");
    const reference: ComputeCaptureReference = {
      schema_version: 1,
      id,
      created_at: packet.captured_at,
      ...(packet.app ? { app: packet.app } : {}),
      root: captureDir,
      files: {
        metadata: metadataPath,
        content: contentPath,
        ...(imagePath ? { image: imagePath } : {}),
      },
      markup: "",
    };
    reference.markup = referenceMarkup(reference);

    const envelope: ReferenceEnvelope = {
      schema_version: 1,
      reference,
      packet: packetForMetadata(packet, imagePath),
    };
    await writeFile(metadataPath, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.signal?.throwIfAborted();
    return reference;
  } catch (error) {
    await removeFailedReference(captureDir, error);
    throw error;
  }
}

export async function copyReferenceMarkupToClipboard(
  markup: string,
  options: ClipboardCopyOptions = {},
): Promise<void> {
  const commands = clipboardCommands(options.platform ?? process.platform);
  const run = options.run ?? runClipboardCommand;
  const failures: string[] = [];
  for (const command of commands) {
    options.signal?.throwIfAborted();
    try {
      if (options.signal) {
        await run(command.command, command.args, markup, options.signal);
      } else {
        await run(command.command, command.args, markup);
      }
      options.signal?.throwIfAborted();
      return;
    } catch (error) {
      options.signal?.throwIfAborted();
      failures.push(`${command.command}: ${errorMessage(error)}`);
    }
  }
  throw new Error(`clipboard copy failed: ${failures.join("; ")}`);
}

export function defaultReferenceRoot(): string {
  return (
    process.env.UNICLI_APP_SHOTS_ROOT?.trim() ||
    join(homedir(), ".unicli", "app-shots")
  );
}

function clipboardCommands(
  platform: NodeJS.Platform,
): Array<{ command: string; args: string[] }> {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-Command",
          "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
        ],
      },
    ];
  }
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function runClipboardCommand(
  command: string,
  args: string[],
  input: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
      ...(signal ? { signal } : {}),
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `exit ${code}`));
    });
    child.stdin.end(input);
  });
}

function referenceMarkup(reference: ComputeCaptureReference): string {
  const image = reference.files.image
    ? ` image="${escapeAttribute(reference.files.image)}"`
    : "";
  return `[app-shots${image} content="${escapeAttribute(reference.files.content)}" metadata="${escapeAttribute(reference.files.metadata)}"]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function captureContent(
  packet: ComputeCapturePacket,
  imagePath: string | undefined,
): string {
  const snapshotData = packet.snapshot?.ok ? packet.snapshot.data : undefined;
  if (isRecord(snapshotData)) {
    const data = snapshotData.data;
    if (typeof data === "string") return normalizeContentText(data);
  }
  if (typeof snapshotData === "string") {
    return normalizeContentText(snapshotData);
  }
  return `${JSON.stringify(packetForMetadata(packet, imagePath), null, 2)}\n`;
}

function normalizeContentText(value: string): string {
  const stripped = value
    .split("\n")
    .map((line) =>
      line
        .replace(
          /\s+\d+(?:\.\d+)?x\d+(?:\.\d+)?@-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g,
          "",
        )
        .replace(/\s+value="<AXUIElement[^"]*"/g, "")
        .replace(/\s+screen=-?\d+/g, ""),
    )
    .join("\n");
  return stripped.endsWith("\n") ? stripped : `${stripped}\n`;
}

async function writeImageEvidence(
  packet: ComputeCapturePacket,
  captureDir: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const screenshotData = packet.screenshot?.ok
    ? packet.screenshot.data
    : undefined;
  const bytes = await imageBytes(screenshotData, signal);
  signal?.throwIfAborted();
  if (!bytes) return undefined;
  const extension = imageExtension(screenshotData, bytes);
  const imagePath = join(captureDir, `image.${extension}`);
  await writeFile(imagePath, bytes, {
    mode: 0o600,
    ...(signal ? { signal } : {}),
  });
  return imagePath;
}

async function imageBytes(
  data: unknown,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  if (Buffer.isBuffer(data)) return data;
  if (!isRecord(data)) return undefined;
  if (typeof data.base64 === "string")
    return Buffer.from(data.base64, "base64");
  if (typeof data.path === "string") {
    try {
      return await readFile(data.path, signal ? { signal } : undefined);
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  return undefined;
}

async function removeFailedReference(
  captureDir: string,
  publicationError: unknown,
): Promise<void> {
  try {
    await rm(captureDir, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [publicationError, cleanupError],
      `capture reference publication and cleanup both failed at ${captureDir}`,
    );
  }
}

function imageExtension(data: unknown, bytes: Buffer): "png" | "jpg" | "bin" {
  const mime = isRecord(data) && typeof data.mime === "string" ? data.mime : "";
  if (mime === "image/png" || isPng(bytes)) return "png";
  if (mime === "image/jpeg" || isJpeg(bytes)) return "jpg";
  return "bin";
}

function referenceId(packet: ComputeCapturePacket): string {
  const slug = slugPart(packet.app ?? "capture");
  const timestamp = packet.captured_at.replace(/[^0-9TZ]/g, "").toLowerCase();
  const hash = createHash("sha256")
    .update(JSON.stringify(packet))
    .digest("hex")
    .slice(0, 10);
  const nonce = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${slug}-${timestamp}-${hash}-${nonce}`;
}

function packetForMetadata(
  packet: ComputeCapturePacket,
  imagePath: string | undefined,
): ComputeCapturePacket {
  const metadataPacket: Omit<ComputeCapturePacket, "visual_timeline"> = {
    schema_version: packet.schema_version,
    captured_at: packet.captured_at,
    ...(packet.app ? { app: packet.app } : {}),
    includes: [...packet.includes],
    trajectory: {
      replayable: true,
      steps: packet.trajectory.steps.map((step) => ({
        ...step,
        params: { ...step.params },
      })),
    },
    ...(packet.snapshot
      ? { snapshot: snapshotPartForMetadata(packet.snapshot) }
      : {}),
    ...(packet.screenshot
      ? { screenshot: screenshotPartForMetadata(packet.screenshot, imagePath) }
      : {}),
  };
  return {
    ...metadataPacket,
    visual_timeline: buildCaptureVisualTimeline(metadataPacket),
  };
}

function snapshotPartForMetadata(
  part: ComputeCapturePacket["snapshot"],
): ComputeCapturePacket["snapshot"] {
  if (!part) return part;
  if (!part.ok) return { ...part, error: cloneError(part.error) };
  if (isRecord(part.data)) {
    return {
      ok: true,
      data: {
        ...part.data,
        ...(typeof part.data.data === "string"
          ? { data: normalizeContentText(part.data.data) }
          : {}),
      },
    };
  }
  if (typeof part.data === "string") {
    return { ok: true, data: normalizeContentText(part.data) };
  }
  return { ok: true, data: part.data };
}

function screenshotPartForMetadata(
  part: ComputeCapturePacket["screenshot"],
  imagePath: string | undefined,
): ComputeCapturePacket["screenshot"] {
  if (!part) return part;
  if (!part.ok) return { ...part, error: cloneError(part.error) };
  if (isRecord(part.data)) {
    const { base64: _base64, ...screenshotData } = part.data;
    return {
      ok: true,
      data: {
        ...screenshotData,
        ...(imagePath ? { path: imagePath } : {}),
      },
    };
  }
  if (Buffer.isBuffer(part.data) && imagePath) {
    return { ok: true, data: { path: imagePath } };
  }
  return { ok: true, data: part.data };
}

function cloneError(
  error: ComputeCapturePart["error"],
): ComputeCapturePart["error"] {
  return error ? { ...error } : undefined;
}

function slugPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "capture";
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8;
}
