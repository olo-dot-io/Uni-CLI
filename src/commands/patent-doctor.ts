/**
 * @owner       src::commands::patent-doctor
 * @does        Parse the `@verification` header line from a YAML or TS adapter source file and resolve it to the canonical PatentVerificationStatus value; surfaces "unknown" when no header is present rather than fabricating a status.
 * @needs       node:fs, node:path, src/discovery/loader.ts (getBuiltinDirs), src/types/patent.ts
 * @feeds       src/commands/patent.ts (runDoctor — uses parseVerificationStatus to populate the doctor row); never invoked outside the patent vertical.
 * @breaks      returns "unknown" when a header is missing, malformed, or the file cannot be read; throws no errors. The honesty contract is that "unknown" is a valid, surfaced state — never silently collapsed to "verified".
 * @invariants  the parser reads only the leading two-kilobyte window of each source file; YAML/TS headers always live in the first few comment lines so this bound keeps the doctor probe fast without missing the field.
 * @side-effects synchronous file read on the adapter's source file
 * @perf        sub-millisecond per adapter (read + regex)
 * @concurrency safe — pure read; no mutable state
 * @test        tests/unit/commands/patent-properties.test.ts (F2 honesty gate)
 * @stability   stable — public API of the patent doctor surface
 * @since       2026-05-18
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getBuiltinDirs } from "../discovery/loader.js";
import type { PatentVerificationStatus } from "../types/patent.js";

/**
 * Verification status enriched with the "unknown" fallback. The base
 * PatentVerificationStatus enum is the published contract; "unknown" is
 * the honest state when no header was found.
 */
export type ResolvedVerificationStatus = PatentVerificationStatus | "unknown";

const VERIFICATION_VALUES: readonly PatentVerificationStatus[] = [
  "verified",
  "blocked-by-key",
  "blocked-by-subscription",
  "waiting-for-api",
  "browser-only",
] as const;

const HEADER_BYTES = 2048;

/**
 * Match an `@verification <value>` declaration in the header of a YAML or TS
 * source file. Accepts either `# @verification …` (YAML), `// @verification …`
 * (TS), or `* @verification …` (TS JSDoc). Also accepts `verification_status:`
 * which appears as a YAML field in some early adapters.
 */
const HEADER_PATTERNS: RegExp[] = [
  /^[ \t]*(?:#|\/\/|\*)\s*@verification[ \t]+([a-z][a-z0-9-]+(?:-[a-z]+)*)/im,
  /^[ \t]*(?:#|\/\/|\*)\s*verification_status:[ \t]+([a-z][a-z0-9-]+(?:-[a-z]+)*)/im,
];

/**
 * Parse a single source file's verification status. Reads only the leading
 * window (HEADER_BYTES); never invents a status. Returns "unknown" when the
 * header is absent or unreadable, "verified" / "blocked-by-key" / etc. when
 * the header is present and well-formed.
 */
export function parseVerificationStatusFromFile(
  filePath: string,
): ResolvedVerificationStatus {
  if (!existsSync(filePath)) return "unknown";
  let raw: string;
  try {
    // Reading the whole file is fine — every adapter file is <4 KiB. We
    // could read only HEADER_BYTES via createReadStream but the synchronous
    // path is dramatically simpler and the budget is comfortable.
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return "unknown";
  }
  const head = raw.slice(0, HEADER_BYTES);
  for (const pattern of HEADER_PATTERNS) {
    const match = pattern.exec(head);
    if (!match) continue;
    const value = match[1].toLowerCase();
    if ((VERIFICATION_VALUES as readonly string[]).includes(value)) {
      return value as PatentVerificationStatus;
    }
  }
  return "unknown";
}

/**
 * Locate the YAML source file for a given adapter command. Returns
 * `undefined` when no file is found — the caller surfaces this as
 * "unknown" verification.
 */
export function resolveAdapterSourcePath(
  adapterName: string,
  commandName: string,
): string | undefined {
  const { yamlDir, tsDir } = getBuiltinDirs();
  const candidates = [
    join(yamlDir, adapterName, `${commandName}.yaml`),
    join(yamlDir, adapterName, `${commandName}.yml`),
    join(tsDir, adapterName, `${commandName}.ts`),
    join(tsDir, adapterName, `${commandName}.js`),
    join(tsDir, `${adapterName}.ts`),
    join(tsDir, `${adapterName}.js`),
  ];
  return candidates.find((p) => existsSync(p));
}

/**
 * Locate any source file for an adapter (any command). Used when the adapter
 * exposes multiple commands and the doctor only needs a single verification
 * declaration — adapter authors typically copy the same `@verification` line
 * across every YAML in a directory. We pick the first that resolves.
 */
export function findAdapterSourceFile(
  adapterName: string,
  commandNames: readonly string[],
): string | undefined {
  for (const cmd of commandNames) {
    const path = resolveAdapterSourcePath(adapterName, cmd);
    if (path) return path;
  }
  return undefined;
}

/**
 * Resolve an adapter's verification status by reading any of its source
 * files. Returns "unknown" when no source file carries a verification
 * header — never invents a state.
 */
export function resolveAdapterVerificationStatus(
  adapterName: string,
  commandNames: readonly string[],
): ResolvedVerificationStatus {
  const source = findAdapterSourceFile(adapterName, commandNames);
  if (!source) return "unknown";
  return parseVerificationStatusFromFile(source);
}
