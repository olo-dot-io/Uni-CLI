---
title: Glossary
description: Plain-language definitions for the terms used in Uni-CLI commands and adapter documentation.
---

# Glossary

## Adapter

A file or module that registers operations for a site, application, service, or tool. Most packaged adapters are YAML. TypeScript covers integrations that need custom control flow.

## AgentEnvelope

The v2 result shape shared by Uni-CLI commands. `ok` indicates the outcome, `data` carries successful output, `error` carries a structured failure, and `meta` describes the call.

## Browser Runtime Broker

The local service that manages browser providers, profiles, sessions, targets, and leases for Uni-CLI browser commands.

## Catalog

The installed collection of operations. Packaged adapters form the static catalog; core commands, user adapters, plugins, and host-discovered CLIs can add entries at runtime.

## Command contract

The machine-readable description returned by `unicli describe`. It covers arguments, authentication, effect, operator, target, examples, and repair metadata.

## Effect

The kind of change an operation can make, such as `read`, `download_file`, `send_message`, `local_file`, or `destructive`. Search and local permission policy can filter by effect.

## Error envelope

The `error` object in a failed AgentEnvelope. It includes a stable code and message, and can include a suggestion, remedy command, retry status, source file, or failed step.

## Execution operator

The interface that performs an operation. Values include `structured-api`, `browser-protocol`, `native-cli`, `browser-semantic`, `desktop-accessibility`, `visual-observation`, `visual-coordinate`, and `local-runtime`.

## MCP

Model Context Protocol. `unicli mcp serve` exposes Uni-CLI to clients that manage tools through MCP.

## Operation

A searchable command with declared arguments, target, effect, operator, and result shape. Its shell form is `unicli <site> <command>`.

## Pipeline

The ordered actions in a YAML adapter. A pipeline can fetch, transform, navigate, interact, download, or control execution.

## Profile

A browser storage partition containing cookies, local storage, and related login state. `unicli browser profiles --json` lists local Chromium profiles that Uni-CLI can use as a source.

## Repair

The verification step after an adapter change. `unicli repair <site> <command>` reruns the target operation and checks its envelope and process status.

## Site

The namespace before a command, such as `hackernews` in `unicli hackernews top`. A site can represent a website, application, service, file type, operating-system surface, or external CLI.

## Strategy

The connection method declared by a web adapter: `public`, `cookie`, `header`, `intercept`, or `ui`.

## User adapter

An adapter stored under `~/.unicli/adapters/`. User adapters support local additions and can take precedence over packaged entries with the same site and command.

## YAML adapter

A declarative adapter containing metadata, arguments, and pipeline steps. `unicli init` creates one and `unicli dev` reloads it during development.
