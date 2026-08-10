# Uni-CLI Copy Rules

> Current version: v1.0.4 — Artemis · Glover.
>
> Current static adapter catalog: <!-- STATS:site_count -->337<!-- /STATS --> sites, <!-- STATS:command_count -->1884<!-- /STATS --> registered commands, <!-- STATS:adapter_count_total -->1261<!-- /STATS --> adapters (<!-- STATS:adapter_count_yaml -->1003<!-- /STATS --> YAML + <!-- STATS:adapter_count_ts -->258<!-- /STATS --> TS). Fixed core and host-discovered commands join at runtime. <!-- STATS:test_count -->10237<!-- /STATS --> tests.

This file keeps docs and user-facing copy consistent. Public pages should expose
install, command, output, and repair facts with the fewest words needed.

## Product Sentence

Uni-CLI is the open Agent-Computer Interface runtime for real software: rank
cataloged operations, let the agent select one with a declared substrate,
apply supported policy, return an inspectable result, and keep supported
failure paths repairable.

Use that sentence as the north star. If a paragraph does not help a user install,
discover, execute, record, inspect, repair, or extend the tool, it probably does
not belong in README.

## Copy Rules

| Do                                        | Avoid                                                             |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Start with install and a working command. | Start with theory, vision, or protocol politics.                  |
| Show exact CLI commands.                  | Describe a feature without an executable path.                    |
| Say what is shipped and what is gated.    | Imply a backend is live when it is only declared.                 |
| Name evidence when behavior is recorded.  | Treat opaque side effects as proof of success.                    |
| Keep adapter repair concrete.             | Say "self-healing" without the `adapter_path` and verify command. |
| Use short tables for capability maps.     | Use giant badge walls or decorative animations.                   |
| Link to references after the quick path.  | Make the first screen a table of contents.                        |

## README Shape

1. Logo, one-line product category, memorable loop, install command.
2. Agent-first quick path: discover, select, govern, act, observe, repair.
3. Category boundaries: what Uni-CLI is and is not.
4. Capability map with real surfaces.
5. Output, evidence, and error contracts.
6. Self-repair loop.
7. Adapter authoring example.
8. Trust, auth, browser, evidence, operation policy, and Visual limits.
9. Development and license.

No scrolling animation. No Mermaid hero diagram. No theory section.

## Docs Site Shape

The VitePress site is the public product surface. Keep it organized by user
need:

| Section     | Purpose                                      | Examples                        |
| ----------- | -------------------------------------------- | ------------------------------- |
| Start       | First successful command and agent setup     | Getting Started, Integrations   |
| Guides      | Task-oriented workflows                      | Adapters, Self-Repair, Recipes  |
| Reference   | Exact contracts and generated/owned surfaces | Pipeline, Exit Codes, Release   |
| Explanation | Why the system is shaped this way            | Architecture, Benchmark, Theory |

Do not add a new top-level doc when a paragraph in an existing page would
serve the reader. If a page mixes task steps, contract details, and rationale,
split or move the smallest section needed instead of duplicating the whole
page.

## Naming

| Context               | Form               |
| --------------------- | ------------------ |
| Human prose           | `Uni-CLI`          |
| npm package           | `@zenalexa/unicli` |
| CLI binary            | `unicli`           |
| Config directory      | `~/.unicli/`       |
| Environment variables | `UNICLI_*`         |

## Honesty Bar

- ACP is compatibility unless the client gives us real session/tool event semantics.
- Visual is only live when a real configured backend performs the action.
- Browser automation requires a reachable browser runtime.
- Run recording is opt-in and local; do not imply all commands are recorded by default.
- Operation policy defaults to `open`; stricter profiles are user-selected.
- Auth-required adapters should say exactly which cookie or credential path is needed.
- Errors always need code and message; add adapter path, step, retryability,
  suggestion, or alternatives only when the failure class supports them.
- A successful dispatch is not automatically a completed objective; name the
  operation-specific evidence when it exists, and do not imply it is universal.
- CLI, MCP, ACP, WebMCP, browser, desktop, subprocess, and visual control are
  substrates or exposure formats, not separate product identities.
- Native CLI is the complete command surface. MCP projects adapter operations;
  fixed-core and other integration parity remain roadmap work.

## Visual Bar

- Prefer stable Markdown that renders well on GitHub, npm, and docs sites.
- Use a small badge row for package state only.
- Use tables and code blocks when they reduce reading time.
- Do not use animated images, badge spam, or decorative diagrams.
- Keep headings factual and short.

## Release Checks

Before release:

```bash
npm run build
npm run release:check
npm run verify
```

The release check requires this file to contain the package version.
