/**
 * @owner       src::transport::cdp-session
 * @does        Persist and load the latest exact CDP renderer attachment as immutable local records.
 * @needs       node crypto/fs/os/path
 * @feeds       compute attach and later cross-process CDP compute commands
 * @breaks      Partial, corrupt, or lost concurrent writes can redirect a later command to the wrong renderer.
 * @invariants  Published records are complete before atomic hard-link visibility; concurrent writers never overwrite each other; legacy aggregate files remain readable; invalid state fails with a typed repair error.
 * @side-effects Creates a private record directory, writes mode-0600 records, and prunes superseded records.
 * @perf        Reads at most eight retained records plus one legacy file.
 * @concurrency Immutable records make publication crash-safe and multi-process-safe without rename-over-existing behavior.
 * @test        tests/unit/cdp-session.test.ts, tests/unit/commands/compute.test.ts
 * @stability   stable
 * @since       0.400.2
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const MAX_RETAINED_SESSION_RECORDS = 8;

export interface CdpSession {
  schema_version: 1;
  port: number;
  webSocketDebuggerUrl: string;
  targetId?: string;
  app?: string;
  savedAt: number;
}

export class CdpSessionStateError extends Error {
  readonly minimum_capability = "compute.cdp_session.state_corrupt";
  readonly exit_code = 78;
  readonly retryable = false;
  readonly suggestion: string;

  constructor(
    readonly statePath: string,
    cause?: unknown,
  ) {
    super(`CDP session state is corrupt at ${statePath}`, { cause });
    this.name = "CdpSessionStateError";
    this.suggestion = `Move the corrupt CDP session at ${statePath} aside, run \`unicli compute attach\` against the intended renderer, and retry.`;
  }
}

export function computeCdpSessionPath(): string {
  return process.env.UNICLI_COMPUTE_CDP_SESSION_PATH ?? defaultCdpSessionPath();
}

export function saveCdpSession(
  session: Omit<CdpSession, "schema_version" | "savedAt">,
  file = computeCdpSessionPath(),
): void {
  if (isDefaultSessionStateDisabled(file)) return;
  const payload: CdpSession = {
    schema_version: 1,
    ...session,
    port: Math.trunc(session.port),
    savedAt: Date.now(),
  };
  if (!isCdpSession(payload)) {
    throw new TypeError("refusing to persist an invalid CDP session");
  }

  const recordDirectory = sessionRecordDirectory(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  mkdirSync(recordDirectory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  const monotonicOrder = process.hrtime.bigint().toString().padStart(20, "0");
  const recordName = `${String(payload.savedAt).padStart(16, "0")}.${monotonicOrder}.${String(process.pid).padStart(10, "0")}.${digest}.json`;
  const recordPath = join(recordDirectory, recordName);
  const temporaryPath = join(
    recordDirectory,
    `.${basename(file)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );

  writeFileSync(temporaryPath, serialized, { flag: "wx", mode: 0o600 });
  try {
    try {
      linkSync(temporaryPath, recordPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    unlinkSync(temporaryPath);
  }
  pruneSessionRecords(recordDirectory);
}

export function loadCdpSession(
  file = computeCdpSessionPath(),
): CdpSession | undefined {
  if (isDefaultSessionStateDisabled(file)) return undefined;
  const records = readSessionRecords(sessionRecordDirectory(file));
  if (records.length > 0) {
    return records.sort(compareSessions).at(-1)?.session;
  }
  if (!existsSync(file)) return undefined;
  return readSessionFile(file);
}

function readSessionRecords(
  recordDirectory: string,
): Array<{ name: string; session: CdpSession }> {
  if (!existsSync(recordDirectory)) return [];
  const records: Array<{ name: string; session: CdpSession }> = [];
  for (const name of readdirSync(recordDirectory).filter((name) =>
    name.endsWith(".json"),
  )) {
    const path = join(recordDirectory, name);
    records.push({ name, session: readSessionFile(path) });
  }
  return records;
}

function readSessionFile(path: string): CdpSession {
  try {
    const text = readFileSync(path, "utf8").trim();
    const raw = text ? (JSON.parse(text) as unknown) : undefined;
    if (isCdpSession(raw)) return raw;
    throw new TypeError("session record does not match schema version 1");
  } catch (error) {
    if (error instanceof CdpSessionStateError) throw error;
    throw new CdpSessionStateError(path, error);
  }
}

function compareSessions(
  left: { name: string; session: CdpSession },
  right: { name: string; session: CdpSession },
): number {
  return (
    left.session.savedAt - right.session.savedAt ||
    left.name.localeCompare(right.name)
  );
}

function pruneSessionRecords(recordDirectory: string): void {
  const names = readdirSync(recordDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of names.slice(0, -MAX_RETAINED_SESSION_RECORDS)) {
    try {
      unlinkSync(join(recordDirectory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function sessionRecordDirectory(file: string): string {
  return `${file}.d`;
}

function defaultCdpSessionPath(): string {
  return join(homedir(), ".unicli", "compute", "cdp-session.json");
}

function isDefaultSessionStateDisabled(file: string): boolean {
  return (
    process.env.UNICLI_COMPUTE_CDP_SESSION_PATH === undefined &&
    file === defaultCdpSessionPath() &&
    (process.env.VITEST !== undefined || process.env.NODE_ENV === "test")
  );
}

function isCdpSession(value: unknown): value is CdpSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Record<string, unknown>;
  return (
    session.schema_version === 1 &&
    typeof session.port === "number" &&
    Number.isSafeInteger(session.port) &&
    session.port >= 1 &&
    session.port <= 65_535 &&
    typeof session.webSocketDebuggerUrl === "string" &&
    isCdpWebSocketUrl(session.webSocketDebuggerUrl) &&
    typeof session.savedAt === "number" &&
    Number.isSafeInteger(session.savedAt) &&
    session.savedAt >= 0 &&
    (session.app === undefined ||
      (typeof session.app === "string" && Boolean(session.app.trim()))) &&
    (session.targetId === undefined ||
      (typeof session.targetId === "string" &&
        Boolean(session.targetId.trim())))
  );
}

function isCdpWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}
