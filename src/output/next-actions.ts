/**
 * Default HATEOAS `next_actions` hints. Every CLI response carries a small
 * set of templates so the agent always has a navigable next step without
 * re-reading docs. Agents read `params.<name>.value` / `.default` / `.enum`
 * to fill templates instead of guessing flag syntax.
 *
 * Pattern from joelclaw.com "CLI Design for AI Agents" (2026-02), refined
 * for Uni-CLI's self-repair contract so failure paths also suggest
 * `unicli repair` + stdin-JSON channel switch.
 */

import type { AgentNextAction } from "./envelope.js";

/** Hints shown alongside a successful result for site-<cmd>. */
export function defaultSuccessNextActions(
  site: string,
  cmdName: string,
  opts?: { supportsPagination?: boolean },
): AgentNextAction[] {
  const actions: AgentNextAction[] = [
    {
      command: `unicli describe ${site} ${cmdName}`,
      description:
        "Inspect the command's JSON schema, channels, and example payload",
    },
    {
      command: `unicli ${site} ${cmdName} --args-file <path.json>`,
      description:
        "Re-run with a JSON payload from file (avoids shell-quote hell)",
      params: {
        path: {
          description: "Absolute path to a JSON object file with command args",
        },
      },
    },
  ];
  if (opts?.supportsPagination) {
    actions.push({
      command: `unicli ${site} ${cmdName} --cursor <next_cursor>`,
      description: "Fetch the next page using meta.pagination.next_cursor",
    });
  }
  return actions;
}

/** Hints shown on the error path — biased toward repair + channel switch. */
export function defaultErrorNextActions(
  site: string,
  cmdName: string,
  errCode: string,
): AgentNextAction[] {
  const actions: AgentNextAction[] = [
    {
      command: `unicli describe ${site} ${cmdName}`,
      description:
        "Read the exact schema the command expects (often resolves invalid_input)",
    },
  ];

  if (
    errCode === "invalid_input" ||
    errCode === "selector_miss" ||
    errCode === "parse_error"
  ) {
    actions.push({
      command: `echo '{...}' | unicli ${site} ${cmdName}`,
      description:
        "Retry using stdin-JSON channel — payloads with quotes/emoji/JSON often fail the shell-args path",
    });
  }

  if (errCode === "auth_required" || errCode === "not_authenticated") {
    actions.push({
      command: `unicli auth setup ${site}`,
      description: "Save cookies / token for this site",
    });
  }

  actions.push({
    command: `unicli repair ${site} ${cmdName}`,
    description:
      "Ask an agent to repair the adapter YAML if the upstream API has drifted",
  });

  return actions;
}
