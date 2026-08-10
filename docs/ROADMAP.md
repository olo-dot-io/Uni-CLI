---
title: Roadmap
description: Shipped foundations and the next engineering priorities for Uni-CLI.
---

# Roadmap

Current release: v1.0.4 — Artemis · Glover.

The static catalog contains <!-- STATS:site_count -->337<!-- /STATS --> sites.

It contains <!-- STATS:command_count -->1884<!-- /STATS --> registered commands. The runtime also adds core and host-discovered commands.

## Shipped

- Local bilingual operation search and command contracts
- v2 success and error envelopes
- Web, browser, desktop, local-tool, file, and protocol operators
- Browser profiles, sessions, targets, and background or foreground visibility
- Desktop accessibility and visual provider routing
- Local permission profiles, approvals, and run records
- YAML adapter authoring, user adapters, and repair verification
- CLI, MCP, and ACP entry points
- Generated operation catalog and bilingual documentation

## In progress

### Contract parity

Core commands and adapter commands are converging on one operation contract across CLI, MCP, ACP, dry-run, generated agent files, and docs.

### Browser and desktop reliability

The current focus is stable background browser control, clearer provider health, durable target ownership, and repeatable accessibility paths for common desktop applications.

### Evidence after actions

Mutating operations are gaining clearer post-action state, effect status, and run comparison so agents can distinguish dispatch from an observed result.

### Adapter authoring

The authoring loop is moving toward shorter scaffolds, reusable site notes, focused fixtures, and repair output that can be applied directly by coding agents.

### Compact discovery

Search, deferred MCP tools, and generated agent indexes are being tuned so a large catalog stays useful while loading only the schemas relevant to the task.

## Later

- More page-native and application-specific operators
- Broader Windows and Linux desktop coverage
- Additional registry inputs that map cleanly to the operation contract
- Stronger replay and comparison for long-running workflows

## How priorities are chosen

A roadmap item advances when it improves a real operation path, a shared contract, or the ability to diagnose a failure. Release history lives in [CHANGELOG.md](https://github.com/olo-dot-io/Uni-CLI/blob/main/CHANGELOG.md).
