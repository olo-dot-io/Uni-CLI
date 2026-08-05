---
title: How Uni-CLI works
description: Follow an intent from local discovery to execution, structured output, and repair.
---

# How Uni-CLI works

Uni-CLI gives agents one command model for websites, browsers, desktop applications, local tools, files, and protocol servers. Every call follows the same four-part path: find an operation, inspect its contract, run it through a declared interface, and read a structured result.

## 1. Discovery stays local

```bash
unicli search "top Hacker News stories"
```

Search runs against the installed catalog. It ranks bilingual descriptions and can filter by effect, operator, target surface, category, and platform. The result identifies a concrete command; it performs no external action.

## 2. The operation describes itself

```bash
unicli describe hackernews top
```

The operation contract includes:

- accepted arguments and defaults
- authentication requirements
- target surface and execution operator
- effect and interaction impact
- source adapter and repair entry point

This lets an agent prepare the call before opening a browser, starting a desktop provider, or contacting a service.

## 3. A declared interface performs the action

An operation can use a structured API, browser protocol, native CLI, browser semantics, desktop accessibility, visual control, or a local runtime. The catalog records that choice as `operator` and `minimum_capability`.

```bash
unicli hackernews top --limit 5 -f json
```

Arguments can arrive from shell flags, stdin JSON, or an args file. The runtime validates them before it acquires the target interface.

## 4. Every call returns an envelope

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "hackernews.top",
  "meta": {
    "duration_ms": 2853,
    "count": 5,
    "surface": "web"
  },
  "data": [],
  "error": null
}
```

Success and failure use the same outer shape. Programs can branch on `ok`, read `data`, and use `error.code` to choose the next step.

## When software changes

An adapter failure can identify its source file and failed pipeline step. After the adapter is updated, `repair` reruns the original command as the verification step.

```bash
unicli repair <site> <command> --dry-run
unicli repair <site> <command>
```

User adapters under `~/.unicli/adapters/` can replace packaged adapters during local development.

## CLI, MCP, and ACP

The CLI is the complete command surface and works with process-based agents, pipes, files, and CI. MCP projects Uni-CLI into clients that use tool servers. ACP provides an agent-client server. All three start from the same operation catalog.

## Continue reading

- [Quickstart](/guide/getting-started)
- [Find an operation](/guide/)
- [Authentication](/guide/authentication)
- [Architecture](/ARCHITECTURE)
