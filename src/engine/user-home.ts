import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Resolve Uni-CLI's user-local base directory.
 *
 * Prefer HOME when present so tests and CI can isolate ~/.unicli state with a
 * single environment override. On Windows, os.homedir() otherwise resolves via
 * USERPROFILE and bypasses HOME-only fixtures.
 */
export function userHome(): string {
  return process.env.HOME || homedir();
}

/** Resolve Uni-CLI's user-local data directory. */
export function userDataRoot(): string {
  return join(userHome(), ".unicli");
}

/**
 * Resolve the user adapter overlay.
 *
 * Evolution verification points this at an isolated baseline or candidate
 * tree while retaining the caller's HOME for auth, browser, and permission
 * state. Ordinary invocations continue to use ~/.unicli/adapters.
 */
export function userAdapterRoot(): string {
  const configured = process.env.UNICLI_USER_ADAPTER_DIR?.trim();
  if (!configured) return join(userDataRoot(), "adapters");
  return isAbsolute(configured) ? configured : resolve(configured);
}
