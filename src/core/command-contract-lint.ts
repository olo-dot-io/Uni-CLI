/**
 * @owner Uni-CLI Core
 * @does Validates command contracts before release surfaces consume them.
 * @needs CommandContract projections.
 * @feeds release gates, unicli lint, benchmark generation, agent packs.
 * @breaks Missing source paths, schemas, target surfaces, or repair commands.
 */

import type {
  CommandContract,
  CommandContractLintIssue,
} from "./command-contract.js";

export function lintCommandContract(
  contract: CommandContract,
): CommandContractLintIssue[] {
  const issues: CommandContractLintIssue[] = [];
  const label = `${contract.identity.site} ${contract.identity.command}`;

  if (contract.identity.source_path === undefined) {
    issues.push({
      code: "missing_source_path",
      severity: "error",
      message: `${label} has no adapter source path`,
    });
  }
  if (Object.keys(contract.schemas.input.properties).length === 0) {
    issues.push({
      code: "missing_input_schema",
      severity: "warning",
      message: `${label} declares no input properties`,
    });
  }
  if (contract.effect.target_surface === undefined) {
    issues.push({
      code: "missing_target_surface",
      severity: "error",
      message: `${label} has no target surface`,
    });
  }
  if (contract.repair.repair_command.length === 0) {
    issues.push({
      code: "missing_repair_command",
      severity: "error",
      message: `${label} has no repair command`,
    });
  }

  return issues;
}
