# Uni-CLI Taste Guide

> Current version: v0.215.1.
>
> Current scale: <!-- STATS:site_count -->223<!-- /STATS --> sites, <!-- STATS:command_count -->1304<!-- /STATS --> commands, <!-- STATS:adapter_count_total -->987<!-- /STATS --> adapters (<!-- STATS:adapter_count_yaml -->907<!-- /STATS --> YAML + <!-- STATS:adapter_count_ts -->80<!-- /STATS --> TS), <!-- STATS:test_count -->7311<!-- /STATS --> tests.

This is the public style bar for docs and user-facing copy. Internal planning,
research notes, and release lore can exist elsewhere, but they should not leak
into the main product entry path.

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
