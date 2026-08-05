---
title: Self-repair
description: Read an adapter failure, update the named source, and verify the original operation.
---

# Self-repair

Real software changes. Uni-CLI helps an agent move from a failed operation to the exact adapter source and a repeatable verification command.

## Read the envelope

Run the target in JSON format and keep its arguments:

```bash
unicli <site> <command> [args] -f json
```

An adapter failure can include:

```json
{
  "ok": false,
  "error": {
    "code": "adapter_error",
    "adapter_path": "src/adapters/example/search.yaml",
    "step": 2,
    "suggestion": "Inspect the selector used by step 2",
    "retryable": false
  }
}
```

`adapter_path` identifies the owned source. `step` points to the pipeline action that produced the failure.

## Preview verification

```bash
unicli repair <site> <command> --dry-run
```

For commands with arguments, pass the original argv as JSON:

```bash
unicli repair <site> <command> \
  --target-args '["query","--limit","2"]' \
  --dry-run
```

The preview shows the adapter path, command, arguments, timeout, and working directory.

## Update the smallest owning boundary

Inspect the named adapter and the upstream response or page state. Common changes include:

- an endpoint or response field moved
- a selector changed
- a required header or cookie changed
- an external CLI changed its output
- a desktop permission or provider needs setup

Update the adapter or its owning runtime component, then add a focused regression check when the behavior is stable.

## Run the verifier

```bash
unicli repair <site> <command> \
  --target-args '["query","--limit","2"]'
```

A successful verification requires an exit code of 0 and a successful envelope from the original operation.

## User-local repairs

Store a local adapter under `~/.unicli/adapters/<site>/` when the repair belongs to one machine or needs more testing. Uni-CLI loads user adapters with higher precedence than packaged entries.

## Quarantined adapters

List commands that are waiting for repair:

```bash
unicli repair --quarantined
```

After the source is updated and the target verifier succeeds, a maintainer can return the adapter to the regular test set.
