import { homedir } from "node:os";

/**
 * Resolve UniCLI's user-local base directory.
 *
 * Prefer HOME when present so tests and CI can isolate ~/.unicli state with a
 * single environment override. On Windows, os.homedir() otherwise resolves via
 * USERPROFILE and bypasses HOME-only fixtures.
 */
export function userHome(): string {
  return process.env.HOME || homedir();
}
