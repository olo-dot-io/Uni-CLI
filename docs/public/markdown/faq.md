<!-- Generated from docs/faq.md. Do not edit this copy directly. -->

# FAQ

- Canonical: https://olo-dot-io.github.io/Uni-CLI/faq
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/faq.md
- Section: Start
- Parent: Start (/)

Quick answers to the questions agents and developers ask most often. Each answer is a standalone summary so AI assistants can quote it directly.

## What is Uni-CLI?

Uni-CLI is the open Agent-Computer Interface runtime for real software. It gives agents one searchable boundary across websites, logged-in browsers, desktop apps, local tools, files, operating-system capabilities, MCP servers, accessibility, and visual control. It ranks cataloged operations by intent, runs the selected operation through its declared substrate under available policy, returns a stable success/error envelope, and keeps supported failure paths repairable. Its static adapter catalog covers <span><!-- STATS:site_count -->326<!-- /STATS --></span> sites; fixed core and host-discovered surfaces join the native CLI at runtime.

## Why call it an Agent-Computer Interface runtime?

An Agent-Computer Interface is the commands an agent can issue and the feedback the computer returns. “Runtime” distinguishes executable behavior from a schema, skill, registry, or documentation layer. Uni-CLI implements that boundary across multiple software interfaces without becoming the model, planner, or agent framework. The term is established in the [SWE-agent paper](https://arxiv.org/abs/2405.15793); Uni-CLI extends the boundary from coding tools to heterogeneous real software.

## How is Uni-CLI different from a browser automation library?

Browser automation is one execution substrate. Uni-CLI's catalog can contain API, file, local CLI, page-native, browser-semantic, desktop-accessibility, and visual operations. Each operation declares its own strategy and substrate; the agent currently selects among candidates rather than relying on universal automatic arbitration. Adapter commands share the adapter kernel and envelope shape, while evidence and repair details remain operation-specific.

## How is Uni-CLI different from a computer-use sandbox?

A computer-use sandbox provides an isolated environment, screen, mouse, keyboard, and often benchmark hooks. Uni-CLI is the interface runtime rather than the sandbox: it can call sandboxed or local boundaries, cross GUI and structured interfaces in one task, and return a shared operation receipt. It does not claim that a user's live machine is isolated like a sandbox.

## Why a CLI instead of an MCP server?

CLI is Uni-CLI's native, inspectable, full command surface: it composes with
files, pipes, exit codes, CI, and local tools without a resident server. MCP is
a first-class protocol/exposure substrate. Modern MCP requests are stateless
and carry protocol metadata per call; legacy clients retain initialization and
session-owned Tasks. Compact, deferred, and expanded profiles project adapter
operations. Fixed core commands remain canonical on native CLI until
command-level parity lands.

## How does self-repair work in Uni-CLI?

When an owned adapter path fails, Uni-CLI emits structured error JSON and can populate the source path, failing step or boundary, retryability, alternatives, and a suggestion. An agent can edit the YAML or code at that path, run `unicli repair <site> <command>` or a bounded delivery verification, and keep the patch in `~/.unicli/adapters/` when the repair is user-local. Fields that do not apply to the failure remain absent rather than being fabricated.

## Which AI agent runtimes work with Uni-CLI?

Any runtime that can spawn a subprocess can use Uni-CLI directly. Uni-CLI also exposes an MCP server, an ACP gateway, and an `AGENTS.md` discovery surface so agents pick it up without manual configuration.

## How many sites and commands does Uni-CLI ship?

v1.0.0 ships a generated static adapter catalog with <span><!-- STATS:site_count -->326<!-- /STATS --></span> sites, <span><!-- STATS:command_count -->1829<!-- /STATS --></span> registered commands, and <span><!-- STATS:adapter_count_total -->1226<!-- /STATS --></span> adapters. Fixed core and host-discovered commands are counted separately at runtime. The repository also contains <span><!-- STATS:pipeline_step_count -->113<!-- /STATS --></span> built-in actions (<span><!-- STATS:pipeline_registered_step_count -->58<!-- /STATS --></span> registered + <span><!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --></span> transport-native) and <span><!-- STATS:test_count -->9983<!-- /STATS --></span> tests. The headline is not the count; it is one Agent-Computer Interface product boundary for discovering, selecting, governing, acting through, observing, and repairing operations across web, browser, desktop, local tools, files, and protocols.

## Can Uni-CLI download papers and read local PDFs?

Yes. `unicli arxiv download <id> --output ./papers -f json` downloads a paper PDF, and `unicli pdf read ./papers/<id>.pdf --first_page 1 --last_page 3 -f json` extracts local text into the same structured envelope shape as web adapters. Agents can search arXiv, download the PDF, read selected pages, and summarize the result without leaving the CLI contract.

## How should agents search ACG, anime, manga, and booru content?

Start with intent search, then narrow by the domain-specific command: `unicli search "Sparkle Honkai Star Rail character"`, `unicli anilist characters "Sparkle" -f json`, `unicli moegirl search "Sparkle Honkai Star Rail" -f json`, or `unicli danbooru tags sparkle -f json`. Booru adapters expose explicit tag workflows, while anime/game/wiki adapters expose entity search, media catalogs, year filters, and popularity/rank/trending sort options where the source supports them.

## Can I add a new site without writing TypeScript?

Yes. The preferred contribution format is a short YAML adapter that names the site, command, strategy, and pipeline. YAML is an authoring format below the operation contract, not the product identity. Run `unicli init <site> <command>` to scaffold one, then `unicli dev <path>` to hot-reload while iterating. Most adapters ship without a single line of TypeScript.

## Does Uni-CLI handle authenticated sites?

Yes. An operation explicitly declares one of `public`, `cookie`, `header`, `intercept`, or `ui`. A bounded HTTP probe may compare `public`, `cookie`, and `header` for diagnostics, but command execution runs only the declared strategy. Cookie/header invocation reads its persisted site credential. `--auth-retry` explicitly selects one source: the selected local-browser profile for `auth_required`, or the live CDP target for `challenge_required`. Fresh values are hidden behind a one-shot capability consumed by exactly one new invocation. A miss or read failure never changes source. `auth import` and `browser cookies` are the explicit persistence commands.

## How does Uni-CLI compare to MCP for token cost?

[docs/BENCHMARK.md](/BENCHMARK) measures representative Uni-CLI `--limit 5` list-style calls at 364-423 tokens (median 412); it does not benchmark third-party MCP clients. Expanded MCP can expose a large catalog, while Uni-CLI's default/deferred profiles and modern host-side tool search load schemas on demand. Measure the actual CLI or MCP profile in the target host rather than assuming one protocol always costs less.

## Is Uni-CLI free and open source?

Yes. Uni-CLI is Apache-2.0 licensed on GitHub at [olo-dot-io/Uni-CLI](https://github.com/olo-dot-io/Uni-CLI) and on npm as [@zenalexa/unicli](https://www.npmjs.com/package/@zenalexa/unicli). There are no paid features, no gated commands, and no telemetry. YAML adapters and pipeline steps are agent-readable and agent-editable.

## Where can I see all commands?

The full operation catalog lives at [/reference/sites](/reference/sites). For agent-readable indexes, fetch [/llms.txt](/llms.txt) for a curated map or [/llms-full.txt](/llms-full.txt) for the concatenated docs.

## How do I report a broken adapter?

Open an issue at [github.com/olo-dot-io/Uni-CLI/issues](https://github.com/olo-dot-io/Uni-CLI/issues) with the structured error JSON. The error envelope already includes the adapter path and failing step, so a fix is usually a single YAML edit.
