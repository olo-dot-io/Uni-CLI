/**
 * @owner Uni-CLI Browser
 * @does Projects browser-backed command metadata into kernel diagnostics.
 * @needs Invocation identity, adapter source path, target surface, and site-memory paths.
 * @feeds InvocationResult diagnostics for CLI/MCP/ACP wrappers and browser evidence tests.
 * @breaks Browser repair when commands do not expose target identity, evidence commands, or site memory locations.
 */

import { siteMemoryPaths } from "../../browser/site-memory.js";
import type { TargetSurface } from "../../types.js";

export interface BrowserCommandDiagnosticInput {
  site: string;
  command: string;
  adapterPath: string;
  targetSurface: TargetSurface;
  browser: boolean;
  domain?: string;
}

export interface BrowserCommandDiagnostic {
  kind: "browser_command";
  site: string;
  command: string;
  adapter_path: string;
  target_surface: TargetSurface;
  evidence: {
    session: string;
    network: string;
    verify: string;
  };
  site_memory: {
    endpoints: string;
    field_map: string;
    notes: string;
    fixtures_dir: string;
    verify_dir: string;
  };
  authoring_loop: string[];
}

export function buildBrowserCommandDiagnostic(
  input: BrowserCommandDiagnosticInput,
): BrowserCommandDiagnostic | undefined {
  if (!input.browser) return undefined;
  const paths = siteMemoryPaths(input.site);
  const analyzeTarget = input.domain ?? `${input.site}.com`;
  return {
    kind: "browser_command",
    site: input.site,
    command: input.command,
    adapter_path: input.adapterPath,
    target_surface: input.targetSurface,
    evidence: {
      session: "unicli browser evidence --render-aware",
      network: "unicli browser network --raw",
      verify: `unicli browser verify ${input.site}/${input.command} --strict-memory`,
    },
    site_memory: {
      endpoints: paths.endpoints,
      field_map: paths.fieldMap,
      notes: paths.notes,
      fixtures_dir: paths.fixturesDir,
      verify_dir: paths.verifyDir,
    },
    authoring_loop: [
      `unicli browser analyze https://${analyzeTarget}`,
      "unicli browser network --filter id,title",
      `unicli browser verify ${input.site}/${input.command} --write-fixture`,
      `unicli repair ${input.site} ${input.command}`,
    ],
  };
}
