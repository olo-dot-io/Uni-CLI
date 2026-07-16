/**
 * @owner       src::commands::generate-permission
 * @does        Canonicalize and authorize one adapter-generation operation across CLI and MCP entry points.
 * @needs       adapter-authoring URL naming and the shared direct-browser permission boundary
 * @feeds       src/commands/generate.ts and src/mcp/handler.ts
 * @breaks      Divergent canonical arguments or operation identity would let one entry point bypass rules approved for the other.
 * @invariants  Authorization completes before browser acquisition, subprocess spawn, network access, or generated-file writes.
 * @side-effects Reads permission and approval files; may persist an explicitly requested approval.
 * @perf        Constant-time canonicalization plus one shared permission evaluation.
 * @concurrency Permission-file stable reads and approval-store append semantics define cross-process behavior.
 * @test        tests/unit/generate-permission.test.ts, tests/unit/mcp/explore-permission.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import type { OperationPolicy } from "../engine/operation-policy.js";
import { extractSiteName } from "./adapter-authoring.js";
import {
  authorizeBrowserOperator,
  type BrowserOperatorPermissionOptions,
} from "./browser/permission.js";

export interface GenerateOperationInput {
  url: string;
  goal?: string;
  timeoutSeconds?: string | number;
  site?: string;
  interact?: boolean;
}

export interface GenerateOperation {
  readonly url: string;
  readonly goal?: string;
  readonly timeoutSeconds: number;
  readonly site: string;
  readonly interact: boolean;
}

export type GeneratePermissionOptions = Omit<
  BrowserOperatorPermissionOptions,
  "argumentValues"
>;

export function resolveGenerateOperation(
  input: GenerateOperationInput,
): GenerateOperation {
  return Object.freeze({
    url: input.url,
    ...(input.goal ? { goal: input.goal } : {}),
    timeoutSeconds: parseTimeoutSeconds(input.timeoutSeconds),
    site: input.site ?? extractSiteName(input.url),
    interact: input.interact === true,
  });
}

export async function authorizeGenerateOperation(
  operation: GenerateOperation,
  options: GeneratePermissionOptions = {},
): Promise<OperationPolicy> {
  return await authorizeBrowserOperator("unicli", "generate", {
    ...options,
    argumentValues: {
      url: operation.url,
      goal: operation.goal ?? "",
      timeoutSeconds: operation.timeoutSeconds,
      site: operation.site,
      interact: operation.interact,
    },
  });
}

function parseTimeoutSeconds(value: string | number | undefined): number {
  const parsed = Number.parseInt(String(value ?? "30"), 10);
  return parsed || 30;
}
