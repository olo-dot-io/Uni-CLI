<!-- Generated from docs/faq.md. Do not edit this copy directly. -->

# FAQ

- Canonical: https://olo-dot-io.github.io/Uni-CLI/faq
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/faq.md
- Section: Start
- Parent: Start (/)

Quick answers to the questions agents and developers ask most often. Each answer is a standalone summary so AI assistants can quote it directly.

## What is Uni-CLI?

Uni-CLI is the universal computer-control platform for agents. It turns websites, logged-in browsers, desktop apps, local tools, files, operating-system capabilities, MCP servers, screenshots, accessibility trees, and app-specific wrappers into governed operations. One path accepts intent, selects an action substrate, executes with policy, returns evidence, diagnoses failure, and repairs or reroutes across <span><!-- STATS:site_count -->320<!-- /STATS --></span> sites and tools.

## How is Uni-CLI different from a browser automation library?

Browser automation is one action substrate. Uni-CLI sits above it with operation contracts, permission policy, evidence receipts, delivery assessment, and repair/reroute paths. A browser command, desktop action, subprocess bridge, MCP route, or app wrapper should all return the same AgentEnvelope and follow the same control loop.

## How is Uni-CLI different from a computer-use sandbox?

A computer-use sandbox gives an agent an environment with screen, mouse, keyboard, and often benchmark hooks. Uni-CLI can use that kind of boundary, but its category is broader: it controls the user's real software environment through the smallest available substrate, from typed APIs and browser CDP to desktop accessibility, subprocesses, files, protocols, and visual fallback.

## Why a CLI instead of an MCP server?

A measured Uni-CLI list-style call lands at a 364-423 token total budget (median 412) per [docs/BENCHMARK.md](/BENCHMARK), while an equivalent MCP server keeps its tool list resident — typically 1,500-3,000 tokens per server, even when idle. Uni-CLI publishes both surfaces; the CLI is the cheap, deterministic primary, and MCP wraps it for runtimes that only speak MCP.

## How does self-repair work in Uni-CLI?

When an operation fails, Uni-CLI emits a structured error JSON containing the source path, failing step or boundary, action, retryability, alternatives, and a one-line suggestion. An agent can edit the YAML or code at that path, run `unicli repair <site> <command>` or a bounded delivery verification, and keep the patch in `~/.unicli/adapters/` when the repair is user-local.

## Which AI agent runtimes work with Uni-CLI?

Any runtime that can spawn a subprocess can use Uni-CLI directly. Uni-CLI also exposes an MCP server, an ACP gateway, and an `AGENTS.md` discovery surface so agents pick it up without manual configuration.

## How many sites and commands does Uni-CLI ship?

v0.400.0 ships a generated operation catalog with <span><!-- STATS:site_count -->320<!-- /STATS --></span> sites, <span><!-- STATS:command_count -->1798<!-- /STATS --></span> commands, <span><!-- STATS:adapter_count_total -->1225<!-- /STATS --></span> adapters, <span><!-- STATS:pipeline_step_count -->105<!-- /STATS --></span> built-in actions (<span><!-- STATS:pipeline_registered_step_count -->50<!-- /STATS --></span> registered + <span><!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --></span> transport-native), and <span><!-- STATS:test_count -->9454<!-- /STATS --></span> tests. The headline is not the count; it is the shared control contract: intent, policy, action substrate, evidence, delivery, repair, and the same AgentEnvelope across web, browser, desktop, local tools, files, and protocols.

## Can Uni-CLI download papers and read local PDFs?

Yes. `unicli arxiv download <id> --output ./papers -f json` downloads a paper PDF, and `unicli pdf read ./papers/<id>.pdf --first_page 1 --last_page 3 -f json` extracts local text into the same structured envelope shape as web adapters. Agents can search arXiv, download the PDF, read selected pages, and summarize the result without leaving the CLI contract.

## How should agents search ACG, anime, manga, and booru content?

Start with intent search, then narrow by the domain-specific command: `unicli search "Sparkle Honkai Star Rail character"`, `unicli anilist characters "Sparkle" -f json`, `unicli moegirl search "Sparkle Honkai Star Rail" -f json`, or `unicli danbooru tags sparkle -f json`. Booru adapters expose explicit tag workflows, while anime/game/wiki adapters expose entity search, media catalogs, year filters, and popularity/rank/trending sort options where the source supports them.

## Can I add a new site without writing TypeScript?

Yes. The preferred contribution format is a short YAML adapter that names the site, command, strategy, and pipeline. YAML is an authoring format below the operation contract, not the product identity. Run `unicli init <site> <command>` to scaffold one, then `unicli dev <path>` to hot-reload while iterating. Most adapters ship without a single line of TypeScript.

## Does Uni-CLI handle authenticated sites?

Yes. Strategies cascade across `public`, `cookie`, `header` (cookie + CSRF), `intercept` (browser XHR capture), and `ui` (interactive). Cookie/header commands use an explicitly persisted file when present or read a live local browser/CDP source into process memory without writing it. `auth import` and `browser cookies` are the explicit persistence commands.

## How does Uni-CLI compare to MCP for token cost?

[docs/BENCHMARK.md](/BENCHMARK) measures real Uni-CLI call budgets at 364-423 tokens (median 412) for `--limit 5` list-style adapters. An MCP server has to keep its tool list in resident context — usually 1,500-3,000 tokens per server — before any tool is invoked. Uni-CLI emits structured error envelopes so agents avoid retry loops that further inflate context.

## Is Uni-CLI free and open source?

Yes. Uni-CLI is Apache-2.0 licensed on GitHub at [olo-dot-io/Uni-CLI](https://github.com/olo-dot-io/Uni-CLI) and on npm as [@zenalexa/unicli](https://www.npmjs.com/package/@zenalexa/unicli). There are no paid features, no gated commands, and no telemetry. YAML adapters and pipeline steps are agent-readable and agent-editable.

## Where can I see all commands?

The full operation catalog lives at [/reference/sites](/reference/sites). For agent-readable indexes, fetch [/llms.txt](/llms.txt) for a curated map or [/llms-full.txt](/llms-full.txt) for the concatenated docs.

## How do I report a broken adapter?

Open an issue at [github.com/olo-dot-io/Uni-CLI/issues](https://github.com/olo-dot-io/Uni-CLI/issues) with the structured error JSON. The error envelope already includes the adapter path and failing step, so a fix is usually a single YAML edit.
