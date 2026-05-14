/**
 * @owner   Social capability command surface.
 * @does    Reports normalized social-media capabilities across registered adapters.
 * @needs   Loaded adapter registry and the shared social capability inference layer.
 * @feeds   CLI users, agents, docs, and platform coverage audits.
 * @breaks  Coverage output drifts if command inference no longer matches adapter names.
 */

import type { Command } from "commander";

import { getAllAdapters } from "../registry.js";
import { detectFormat, format } from "../output/formatter.js";
import type {
  AdapterArg,
  AdapterCommand,
  AdapterManifest,
  OutputFormat,
  SocialCapability,
} from "../types.js";
import {
  buildSocialAudit,
  buildSocialCoverage,
  SOCIAL_CAPABILITY_ORDER,
} from "../social/capabilities.js";
import { buildInvocation, execute } from "../engine/kernel/execute.js";
import { refreshCookiesFromBrowser } from "../engine/cookies.js";

export const HIGHLIGHTED_SOCIAL_SITES = [
  "xiaohongshu",
  "bilibili",
  "youtube",
  "twitter",
  "reddit",
  "zhihu",
  "weixin",
  "tiktok",
  "douyin",
  "instagram",
  "facebook",
  "threads",
] as const;

function parseCapability(
  value: string | undefined,
): SocialCapability | undefined {
  if (!value) return undefined;
  if (!SOCIAL_CAPABILITY_ORDER.includes(value as SocialCapability)) {
    throw new Error(
      `Invalid social capability "${value}". Expected one of: ${SOCIAL_CAPABILITY_ORDER.join(", ")}`,
    );
  }
  return value as SocialCapability;
}

function emitInvalidCapabilityError(
  fmt: OutputFormat,
  command: string,
  startedAt: number,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    format(null, undefined, fmt, {
      command,
      duration_ms: Date.now() - startedAt,
      surface: "web",
      error: {
        code: "invalid_input",
        message,
        suggestion: "Use one of the documented social capability names.",
        retryable: false,
        alternatives: ["unicli social coverage", "unicli social audit"],
      },
    }),
  );
  process.exitCode = 2;
}

function isWriteCommentCommand(command: AdapterCommand): boolean {
  return (command.adapterArgs ?? []).some((arg) =>
    ["text", "body", "content"].includes(arg.name),
  );
}

export function selectCommentCommand(
  adapter: AdapterManifest | undefined,
  preferred?: string,
): string | undefined {
  if (!adapter) return undefined;
  const candidates = preferred
    ? [preferred]
    : ["comments", "comment", ...Object.keys(adapter.commands).sort()];
  for (const name of candidates) {
    const command = adapter.commands[name];
    if (!command || isWriteCommentCommand(command)) continue;
    const capabilities = command.socialCapabilities ?? [];
    if (
      name === "comments" ||
      name === "comment" ||
      capabilities.includes("comments")
    ) {
      return name;
    }
  }
  return undefined;
}

function parseKindTarget(target: string): { kind?: string; target: string } {
  const match = /^(answer|question|article|pin|note|video):(.+)$/i.exec(target);
  if (!match) return { target };
  return { kind: match[1].toLowerCase(), target: match[2] };
}

function targetArgName(args: AdapterArg[]): string | undefined {
  const names = [
    "url",
    "bvid",
    "videoId",
    "note-id",
    "id",
    "aweme_id",
    "post_id",
    "thread_id",
    "tweet_id",
  ];
  return names.find((name) => args.some((arg) => arg.name === name));
}

export function buildSocialCommentArgs(
  site: string,
  command: AdapterCommand,
  target: string,
  opts: {
    kind?: string;
    limit?: string;
    withReplies?: boolean;
    sort?: string;
  },
): Record<string, unknown> {
  const parsed = parseKindTarget(target);
  const args = command.adapterArgs ?? [];
  const result: Record<string, unknown> = {};
  const contentArg = targetArgName(args);
  if (contentArg) result[contentArg] = parsed.target;
  if (args.some((arg) => arg.name === "type")) {
    const kind = opts.kind ?? parsed.kind;
    if (!kind && site === "zhihu") {
      throw new Error(
        "Zhihu comments need a target kind. Use --kind answer or target answer:<id>.",
      );
    }
    if (kind) result.type = kind;
  }
  if (args.some((arg) => arg.name === "limit")) {
    result.limit = Number(opts.limit ?? 20);
  }
  if (args.some((arg) => arg.name === "with-replies")) {
    result["with-replies"] = opts.withReplies === true;
  }
  if (opts.sort && args.some((arg) => arg.name === "sort")) {
    result.sort = opts.sort;
  }
  return result;
}

export function registerSocialCommand(program: Command): void {
  const social = program
    .command("social")
    .description("Inspect normalized social-media capabilities");

  social
    .command("coverage")
    .description("List social capability coverage across registered sites")
    .option("--site <site>", "filter by site substring")
    .option("--capability <capability>", "filter by inferred social capability")
    .option(
      "--highlighted",
      "show only the high-value social platforms called out by the project",
    )
    .action(
      (opts: { site?: string; capability?: string; highlighted?: boolean }) => {
        const startedAt = Date.now();
        const fmt = detectFormat(
          program.opts().format as OutputFormat | undefined,
        );
        let capability: SocialCapability | undefined;
        try {
          capability = parseCapability(opts.capability);
        } catch (err) {
          emitInvalidCapabilityError(fmt, "social.coverage", startedAt, err);
          return;
        }
        let rows = buildSocialCoverage(getAllAdapters(), {
          highlightedSites: [...HIGHLIGHTED_SOCIAL_SITES],
        });

        if (opts.site) {
          rows = rows.filter((row) => row.site.includes(opts.site ?? ""));
        }
        if (opts.highlighted) {
          rows = rows.filter((row) => row.highlighted);
        }
        if (capability) {
          rows = rows.filter((row) => row.capabilities.includes(capability));
        }

        console.log(
          format(
            rows,
            ["site", "commands", "capabilities", "highlighted"],
            fmt,
            {
              command: "social.coverage",
              duration_ms: Date.now() - startedAt,
              surface: "web",
            },
          ),
        );
      },
    );

  social
    .command("audit")
    .description(
      "Audit high-value social platforms against required capabilities",
    )
    .option("--gaps", "show only platforms with missing capabilities")
    .action((opts: { gaps?: boolean }) => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );
      let rows = buildSocialAudit(getAllAdapters());
      if (opts.gaps) rows = rows.filter((row) => row.status === "gap");
      console.log(
        format(
          rows,
          ["site", "status", "commands", "required", "capabilities", "missing"],
          fmt,
          {
            command: "social.audit",
            duration_ms: Date.now() - startedAt,
            surface: "web",
          },
        ),
      );
    });

  social
    .command("comments")
    .description("Fetch comments through the normalized social comment layer")
    .argument("<site>", "social platform site name")
    .argument("<target>", "post, video, note, URL, or kind:id target")
    .option("--command <command>", "specific adapter command to use")
    .option("--kind <kind>", "platform-specific target kind, e.g. answer")
    .option("--limit <limit>", "number of root comments", "20")
    .option("--sort <sort>", "platform-specific sort order")
    .option("--with-replies", "include nested replies when supported")
    .action(
      async (
        site: string,
        target: string,
        opts: {
          command?: string;
          kind?: string;
          limit?: string;
          sort?: string;
          withReplies?: boolean;
        },
      ) => {
        const startedAt = Date.now();
        const fmt = detectFormat(
          program.opts().format as OutputFormat | undefined,
        );
        const adapter = getAllAdapters().find((item) => item.name === site);
        const commandName = selectCommentCommand(adapter, opts.command);
        if (!adapter || !commandName) {
          throw new Error(`No readable comment command found for ${site}`);
        }
        const command = adapter.commands[commandName];
        const inv = buildInvocation(
          "cli",
          site,
          commandName,
          {
            args: buildSocialCommentArgs(site, command, target, opts),
            source: "internal",
          },
          { approved: true },
        );
        if (!inv) throw new Error(`Unknown command: ${site}.${commandName}`);
        const result = await execute(inv);
        let finalResult = result;
        const rootOpts = program.opts() as { authRetry?: boolean };
        if (
          rootOpts.authRetry === true &&
          result.error?.code === "auth_required"
        ) {
          const refresh = await refreshCookiesFromBrowser(
            site,
            command.domain ?? adapter.domain,
          );
          if (refresh.ok) {
            process.stderr.write(
              `[auth] refreshed ${refresh.cookieCount ?? 0} cookie(s) from ${refresh.source}; retrying ${site}.${commandName}\n`,
            );
            finalResult = await execute(inv);
          } else if (finalResult.error) {
            finalResult.error.suggestion = [
              finalResult.error.suggestion,
              refresh.suggestion,
            ]
              .filter(Boolean)
              .join(" ");
            finalResult.error.remedy = {
              message:
                refresh.suggestion ??
                "Refresh browser login state, then retry.",
              command: `unicli auth import ${site}`,
            };
            finalResult.envelope.error = finalResult.error;
          }
        }
        if (finalResult.error) {
          process.stderr.write(
            format([], command.columns, fmt, finalResult.envelope),
          );
          process.stderr.write("\n");
          process.exit(finalResult.exitCode);
        }
        console.log(
          format(finalResult.results, command.columns, fmt, {
            ...finalResult.envelope,
            command: "social.comments",
            duration_ms: Date.now() - startedAt,
          }),
        );
      },
    );
}
