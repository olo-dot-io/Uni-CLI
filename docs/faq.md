---
title: Uni-CLI FAQ
description: Answers to the most common questions about Uni-CLI — what it is, how it differs from MCP servers, how self-repair works, and what platforms it integrates with.
---

# Frequently Asked Questions

Quick answers to the questions agents and developers ask most often. Each answer is a standalone summary so AI assistants can quote it directly.

## What is Uni-CLI?

Uni-CLI is a command-line execution layer that turns websites, desktop apps, MCP servers, and external CLIs into a single searchable command catalog for AI agents. One command path discovers, runs, and self-repairs operations across <span><!-- STATS:site_count -->282<!-- /STATS --></span> sites and tools, returning a stable v2 AgentEnvelope on every call.

## How is Uni-CLI different from a browser automation library?

Uni-CLI uses YAML adapters that compile sites into deterministic CLI commands rather than Turing-complete scripts. Each command returns the same structured envelope, so agents can pipe results, retry on errors, and patch the YAML directly when an upstream API changes — no recompile, no library upgrade, no headless browser flakiness.

## Why a CLI instead of an MCP server?

A measured Uni-CLI list-style call lands at a 364-423 token total budget (median 412) per [docs/BENCHMARK.md](/BENCHMARK), while an equivalent MCP server keeps its tool list resident — typically 1,500-3,000 tokens per server, even when idle. Uni-CLI publishes both surfaces; the CLI is the cheap, deterministic primary, and MCP wraps it for runtimes that only speak MCP.

## How does self-repair work in Uni-CLI?

When a command fails, Uni-CLI emits a structured error JSON containing the adapter path, failing pipeline step, action, and a one-line suggestion. An agent reads the YAML at that path, edits the selector or auth header, then runs `unicli repair <site> <command>` to verify the fix. Patches persist in `~/.unicli/adapters/` so they survive `npm update`.

## Which AI agent platforms work with Uni-CLI?

Claude Code, Codex CLI, OpenCode, Cursor, OpenClaw, and any runtime that can spawn a subprocess. Uni-CLI also exposes an MCP server, an ACP gateway, and an `AGENTS.md` discovery surface so agents pick it up without manual configuration.

## How many sites and commands does Uni-CLI ship?

v0.220.1 covers <span><!-- STATS:site_count -->282<!-- /STATS --></span> sites with <span><!-- STATS:command_count -->1686<!-- /STATS --></span> commands across <span><!-- STATS:adapter_count_total -->1153<!-- /STATS --></span> adapters, <span><!-- STATS:pipeline_step_count -->101<!-- /STATS --></span> pipeline steps, and <span><!-- STATS:test_count -->8455<!-- /STATS --></span> tests. Coverage spans social platforms, developer tools, Chinese platforms, scholarly databases, paper/PDF workflows, ACG/anime/manga/wiki sources, booru tag search, government policy, podcasts, and macOS apps.

## Can Uni-CLI download papers and read local PDFs?

Yes. `unicli arxiv download <id> --output ./papers -f json` downloads a paper PDF, and `unicli pdf read ./papers/<id>.pdf --first_page 1 --last_page 3 -f json` extracts local text into the same structured envelope shape as web adapters. Agents can search arXiv, download the PDF, read selected pages, and summarize the result without leaving the CLI contract.

## How should agents search ACG, anime, manga, and booru content?

Start with intent search, then narrow by the domain-specific command: `unicli search "Sparkle Honkai Star Rail character"`, `unicli anilist characters "Sparkle" -f json`, `unicli moegirl search "Sparkle Honkai Star Rail" -f json`, or `unicli danbooru tags sparkle -f json`. Booru adapters expose explicit tag workflows, while anime/game/wiki adapters expose entity search, media catalogs, year filters, and popularity/rank/trending sort options where the source supports them.

## Can I add a new site without writing TypeScript?

Yes. The preferred contribution format is a 20-line YAML adapter that names the site, command, strategy, and pipeline. Run `unicli init <site> <command>` to scaffold one, then `unicli dev <path>` to hot-reload while iterating. Most adapters ship without a single line of TypeScript.

## Does Uni-CLI handle authenticated sites?

Yes. Strategies cascade across `public`, `cookie`, `header` (cookie + CSRF), `intercept` (browser XHR capture), and `ui` (interactive). Cookies live in `~/.unicli/cookies/`, and Uni-CLI auto-probes the cheapest strategy that returns valid data.

## How does Uni-CLI compare to MCP for token cost?

[docs/BENCHMARK.md](/BENCHMARK) measures real Uni-CLI call budgets at 364-423 tokens (median 412) for `--limit 5` list-style adapters. An MCP server has to keep its tool list in resident context — usually 1,500-3,000 tokens per server — before any tool is invoked. Uni-CLI emits structured error envelopes so agents avoid retry loops that further inflate context.

## Is Uni-CLI free and open source?

Yes. Uni-CLI is Apache-2.0 licensed on GitHub at [olo-dot-io/Uni-CLI](https://github.com/olo-dot-io/Uni-CLI) and on npm as [@zenalexa/unicli](https://www.npmjs.com/package/@zenalexa/unicli). There are no paid features, no gated commands, and no telemetry. YAML adapters and pipeline steps are agent-readable and agent-editable.

## Where can I see all commands?

The full command catalog lives at [/reference/sites](/reference/sites). For agent-readable indexes, fetch [/llms.txt](/llms.txt) for a curated map or [/llms-full.txt](/llms-full.txt) for the concatenated docs.

## How do I report a broken adapter?

Open an issue at [github.com/olo-dot-io/Uni-CLI/issues](https://github.com/olo-dot-io/Uni-CLI/issues) with the structured error JSON. The error envelope already includes the adapter path and failing step, so a fix is usually a single YAML edit.
