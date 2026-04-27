# Uni-CLI Copy Rules

> Current version: v0.216.3 — Apollo · Collins.
>
> Current scale: <!-- STATS:site_count -->235<!-- /STATS --> sites, <!-- STATS:command_count -->1448<!-- /STATS --> commands, <!-- STATS:adapter_count_total -->1039<!-- /STATS --> adapters (<!-- STATS:adapter_count_yaml -->917<!-- /STATS --> YAML + <!-- STATS:adapter_count_ts -->122<!-- /STATS --> TS), <!-- STATS:test_count -->7461<!-- /STATS --> tests.

This file keeps docs and user-facing copy consistent. Public pages should expose
install, command, output, and repair facts with the fewest words needed.

## Product Sentence

Uni-CLI adapts software surfaces into commands that agents can discover, run,
and repair.

Use that sentence as the north star. If a paragraph does not help a user install,
run, inspect, repair, or extend the tool, it probably does not belong in README.

## Copy Rules

| Do                                        | Avoid                                                             |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Start with install and a working command. | Start with theory, vision, or protocol politics.                  |
| Show exact CLI commands.                  | Describe a feature without an executable path.                    |
| Say what is shipped and what is gated.    | Imply a backend is live when it is only declared.                 |
| Keep adapter repair concrete.             | Say "self-healing" without the `adapter_path` and verify command. |
| Use short tables for capability maps.     | Use giant badge walls or decorative animations.                   |
| Link to references after the quick path.  | Make the first screen a table of contents.                        |

## README Shape

1. Logo, one-line product sentence, install command.
2. Agent-first quick path: search, run, repair.
3. Capability map with real surfaces.
4. Output contract and error contract.
5. Self-repair loop.
6. Adapter authoring example.
7. Trust, auth, browser, and CUA limits.
8. Development and license.

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
- CUA is only live when a real configured backend performs the action.
- Browser automation requires a reachable browser runtime.
- Auth-required adapters should say exactly which cookie or credential path is needed.
- Errors should be useful to an agent: code, message, adapter path, step, retryability, suggestion, alternatives.

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
