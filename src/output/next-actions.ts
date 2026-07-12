/**
 * @owner       src::output::next-actions
 * @does        Builds bounded HATEOAS command hints for success and failure envelopes.
 * @needs       auth guidance and canonical adapter-repair eligibility
 * @feeds       default AgentEnvelope next_actions across adapter commands
 * @breaks      Misclassified hints can send agents into retries or source edits that cannot fix the owning failure.
 * @invariants  Auth/network/rate-limit failures never recommend adapter repair; drift classes describe repair as verification only.
 * @side-effects None.
 * @perf        O(1) with a bounded action list.
 * @concurrency Pure and reentrant.
 * @test        tests/unit/output/next-actions.test.ts
 * @stability   public
 * @since       2026-04-01
 */

import type { AgentNextAction } from "./envelope.js";
import {
  authImportCommand,
  authLoginUrl,
  authRetryCommand,
  browserCookieCaptureCommand,
} from "./auth-guidance.js";
import { isAdapterRepairCandidate } from "../engine/repair/failure-classifier.js";

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

/** Hints shown on the error path, classified before source repair is offered. */
export function defaultErrorNextActions(
  site: string,
  cmdName: string,
  errCode: string,
  domain?: string,
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
      command: authImportCommand(site, domain),
      description:
        "Import cookies from an installed browser profile without launching a new login flow",
    });
  }

  if (
    errCode === "auth_required" ||
    errCode === "not_authenticated" ||
    errCode === "challenge_required"
  ) {
    actions.push({
      command: `unicli browser open ${authLoginUrl(site, domain)}`,
      description:
        "Open the site in the shared browser profile so the user or agent can complete login/challenge, then retry",
    });
    if (errCode === "challenge_required") {
      actions.push({
        command: browserCookieCaptureCommand(site, domain),
        description:
          "Capture the just-verified shared-browser cookies for the adapter",
      });
    }
    actions.push({
      command: authRetryCommand(site, cmdName),
      description:
        "Refresh browser cookies and retry this command once using an args-file payload",
      params: {
        path: {
          description:
            "Absolute path to the JSON args used for the failed call",
        },
      },
    });
  }

  if (isAdapterRepairCandidate(errCode)) {
    actions.push({
      command: `unicli repair ${site} ${cmdName}`,
      description:
        "Verify an evidence-backed adapter fix with the exact original command",
    });
  }

  return actions;
}
