import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CdpSession {
  schema_version: 1;
  port: number;
  webSocketDebuggerUrl: string;
  app?: string;
  savedAt: number;
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
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
}

export function loadCdpSession(
  file = computeCdpSessionPath(),
): CdpSession | undefined {
  if (isDefaultSessionStateDisabled(file)) return undefined;
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8").trim();
  if (!text) return undefined;
  const raw = JSON.parse(text) as unknown;
  return isCdpSession(raw) ? raw : undefined;
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
  return (
    typeof value === "object" &&
    value !== null &&
    "schema_version" in value &&
    value.schema_version === 1 &&
    "port" in value &&
    typeof value.port === "number" &&
    Number.isFinite(value.port) &&
    "webSocketDebuggerUrl" in value &&
    typeof value.webSocketDebuggerUrl === "string" &&
    "savedAt" in value &&
    typeof value.savedAt === "number" &&
    (!("app" in value) || typeof value.app === "string")
  );
}
