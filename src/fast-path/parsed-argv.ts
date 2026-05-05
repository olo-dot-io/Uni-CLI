/**
 * The parsed-argv shape consumed by every fast-path handler. Lives in its
 * own file so handlers do not have to take a circular import on the entry.
 */

import type { OutputFormat } from "../types.js";

export type ParsedArgv = {
  command?: string;
  rest: string[];
  format?: OutputFormat;
  dryRun: boolean;
  permissionProfile?: string;
  yes: boolean;
  rememberApproval: boolean;
  record: boolean;
};
