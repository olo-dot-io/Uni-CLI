/**
 * @owner       src::output::next-actions
 * @does        Builds bounded HATEOAS command hints for success and failure envelopes.
 * @needs       auth guidance, executable-auth metadata, and canonical adapter-repair eligibility
 * @feeds       default AgentEnvelope next_actions across adapter commands
 * @breaks      Misclassified or duplicate hints can send agents into repeated retries or source edits that cannot fix the owning failure.
 * @invariants  Auth/network/rate-limit failures never recommend adapter repair; drift classes describe repair as verification only; each returned command appears at most once.
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

function uniqueActions(actions: AgentNextAction[]): AgentNextAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.command)) return false;
    seen.add(action.command);
    return true;
  });
}

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
  auth?: {
    setupCommand?: string;
    alternatives?: readonly string[];
  },
): AgentNextAction[] {
  const actions: AgentNextAction[] = [
    {
      command: `unicli describe ${site} ${cmdName}`,
      description:
        "Read the exact schema the command expects (often resolves invalid_input)",
    },
  ];

  if (site === "ai" && cmdName === "search" && errCode === "empty_result") {
    const exactRetries = (auth?.alternatives ?? []).filter((command) =>
      command.startsWith("unicli ai search "),
    );
    const directTargets = [...new Set(auth?.alternatives ?? [])]
      .filter(
        (command) =>
          command.startsWith("unicli ") &&
          !command.startsWith("unicli ai search ") &&
          command !== "unicli ai sources" &&
          !command.startsWith("unicli repair ai search"),
      )
      .slice(0, 4);
    actions.push(
      ...exactRetries.map((command) => ({
        command,
        description:
          "Retry the same AI scope with the unsupported strict freshness bound removed",
      })),
      ...directTargets.map((command) => ({
        command,
        description:
          "Inspect a maintained first-party target reported by the empty AI scope",
      })),
      {
        command: "unicli ai sources",
        description:
          "Inspect the live AI source matrix and choose a wider scope",
      },
      {
        command: "unicli ai search <broader-query> --sources all",
        description: "Broaden the query across every registered AI source",
        params: {
          "broader-query": {
            description: "A broader AI or AI-infrastructure search query",
          },
        },
      },
    );
  }

  if (site === "ai" && cmdName === "search" && errCode !== "empty_result") {
    const sourceRecovery = [...new Set(auth?.alternatives ?? [])]
      .filter(
        (command) =>
          command.startsWith("unicli ") &&
          !command.startsWith("unicli repair ai search"),
      )
      .slice(0, 3);
    actions.push(
      ...sourceRecovery.map((command) => ({
        command,
        description:
          "Retry the concrete source boundary reported by the AI aggregator",
      })),
    );
  }

  if (site === "duckduckgo" && errCode === "challenge_required") {
    actions.push(
      {
        command: "unicli yahoo search <query>",
        description:
          "Retry through a keyless public web index that is not challenge-blocked",
        params: {
          query: { description: "The original web search query" },
        },
      },
      {
        command: "unicli brave search <query>",
        description: "Try the other registered keyless public web index",
        params: {
          query: { description: "The original web search query" },
        },
      },
    );
    return uniqueActions(actions);
  }

  if (site === "ai" && cmdName === "read" && errCode === "challenge_required") {
    const readerAlternatives = [...new Set(auth?.alternatives ?? [])].filter(
      (command) => command.startsWith("unicli "),
    );
    actions.push(
      ...readerAlternatives.map((command) => ({
        command,
        description:
          "Retry through the concrete reader or source boundary reported by ai.read",
      })),
    );
    return uniqueActions(actions);
  }

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

  const isAuthenticationFailure =
    errCode === "auth_required" || errCode === "not_authenticated";
  const exactAuthCommands = Array.from(
    new Set(
      [auth?.setupCommand, ...(auth?.alternatives ?? [])].filter(
        (command): command is string => Boolean(command),
      ),
    ),
  );

  if (isAuthenticationFailure && exactAuthCommands.length > 0) {
    actions.push(
      ...exactAuthCommands.map((command) => ({
        command,
        description:
          "Authenticate at the command's declared credential boundary",
      })),
    );
  } else if (isAuthenticationFailure) {
    actions.push({
      command: authImportCommand(site, domain),
      description:
        "Import cookies from an installed browser profile without launching a new login flow",
    });
  }

  if (
    (isAuthenticationFailure && exactAuthCommands.length === 0) ||
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

  if (
    isAdapterRepairCandidate(errCode) &&
    !(site === "ai" && cmdName === "search")
  ) {
    actions.push({
      command: `unicli repair ${site} ${cmdName}`,
      description:
        "Verify an evidence-backed adapter fix with the exact original command",
    });
  }

  return uniqueActions(actions);
}
