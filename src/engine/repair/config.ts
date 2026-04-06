/**
 * RepairConfig — configuration types and defaults for the self-repair loop.
 */

export type MetricDirection = "higher" | "lower";

export interface RepairConfig {
  site: string;
  command?: string;
  maxIterations: number;
  timeout: number;
  direction: MetricDirection;
  metricPattern: RegExp;
  scope: string[];
  verify: string;
  guard?: string;
  minDelta: number;
}

/**
 * Extract metric value from command stdout using the configured pattern.
 * For SCORE=N/M, returns N (the numerator).
 * Returns null if no match found.
 */
export function extractMetric(stdout: string, pattern: RegExp): number | null {
  pattern.lastIndex = 0; // Reset for stateful (global/sticky) regexes
  const match = pattern.exec(stdout);
  if (!match || match[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isNaN(value) ? null : value;
}

/**
 * Build sensible defaults for a repair config targeting a site (and optional command).
 */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

export function buildDefaultConfig(
  site: string,
  command?: string,
): RepairConfig {
  if (!SAFE_NAME.test(site)) throw new Error(`Invalid site name: ${site}`);
  if (command && !SAFE_NAME.test(command))
    throw new Error(`Invalid command name: ${command}`);

  const scope = [
    `src/adapters/${site}/**/*.yaml`,
    `src/adapters/${site}/**/*.ts`,
  ];

  const verify = command
    ? `npx unicli test ${site} ${command}`
    : `npx unicli test ${site}`;

  return {
    site,
    command,
    maxIterations: 20,
    timeout: 90_000,
    direction: "higher",
    metricPattern: /SCORE=(\d+)\/(\d+)/,
    scope,
    verify,
    guard: undefined,
    minDelta: 0,
  };
}
