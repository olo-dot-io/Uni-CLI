import { randomBytes } from "node:crypto";

export interface BrowserWorkspaceOptions {
  workspace?: string;
  isolated?: boolean;
  sharedSession?: boolean;
}

export function createOneShotWorkspace(prefix: string): string {
  return `${prefix}:${process.pid}:${Date.now()}:${randomBytes(4).toString("hex")}`;
}

export function resolveBrowserWorkspace(
  prefix: string,
  opts: BrowserWorkspaceOptions = {},
): string {
  const explicit = opts.workspace?.trim();
  if (explicit) return explicit;
  if (opts.sharedSession) return `${prefix}:default`;
  if (opts.isolated) return createOneShotWorkspace(prefix);
  return `${prefix}:default`;
}
