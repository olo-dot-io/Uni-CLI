---
title: Self-repair
description: Read an adapter failure, update the named source, and verify the original operation.
---

# Self-repair

Real software changes. Uni-CLI helps an agent move from a failed operation to the exact adapter source and a repeatable verification command.

## Read the envelope

Run the target in JSON format and keep its arguments.

```bash
unicli <site> <command> [args] -f json
```

An adapter failure can include the following fields.

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

For commands with arguments, pass the original argv as JSON.

```bash
unicli repair <site> <command> \
  --target-args '["query","--limit","2"]' \
  --dry-run
```

The preview shows the adapter path, command, arguments, timeout, and working directory.

## Update the smallest owning boundary

Inspect the named adapter and the upstream response or page state. Common changes include the following cases.

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

List commands that are waiting for repair.

```bash
unicli repair --quarantined
```

After the source is updated and the target verifier succeeds, a maintainer can return the adapter to the regular test set.

## Evolve a repeated repair

Use an evolution session when one successful replay is too weak to justify a persistent override. Proposal evidence, validation cases, and held-out cases stay separate.

```bash
unicli --record <site> <command> [args]
unicli runs list -f json

unicli -f json evolve adapter <site> <command> \
  --run <proposal-run> \
  --candidate <candidate.yaml> \
  --hypothesis "<expected mechanism>" \
  --expect <validation-case-id> \
  --risk <held-out-case-id> \
  --validation <validation-eval.yaml> \
  --held-out <held-out-eval.yaml> \
  --promote
```

This direct path creates the session, distills the proposal runs, executes isolated baseline and candidate overlays, evaluates the prediction, applies the promotion gate, and installs the override in one invocation. Proposal evidence contains trace references and redacted failure summaries. It excludes replay arguments and secret event fields, and marks all distilled trace content as untrusted.

```bash
unicli -f json evolve inspect
unicli -f json evolve verify <session-id> --promote
unicli -f json evolve rollback <session-id>
```

Omit `--candidate` to create a draft and edit the returned `candidate.path` before `evolve verify`. The gate keeps the baseline when the candidate is unchanged, validation does not strictly improve, any validation case regresses, held-out evaluation is empty, or a held-out case regresses. Promotion writes `~/.unicli/adapters/<site>/<command>.yaml`. `rollback` restores the pre-promotion overlay and stops if that file has changed since promotion.

Each verification appends an attempt directory containing the exact candidate, patch, and report. Content hashes make later artifact changes fail closed. A rejected attempt remains intact after the Agent edits the draft and verifies again. Running `evolve verify <session-id> --promote` on an unchanged verified draft installs the stored attempt without repeating its eval cases. Competing promotion and rollback processes serialize on the session. An interrupted transition resumes from its prepared promotion record.

Read-only operations can run through the gate by default. Use `--allow-mutation-eval` only when every validation target is an intended controlled environment. Every mutating eval case must also declare an `effectStatus` judge that requires `confirmed`, so process success alone cannot promote a candidate. A candidate may repair same-origin endpoint paths, selectors, extraction expressions, and existing pipeline action configuration. It cannot change operation identity, input or output contracts, pipeline action topology, request methods or headers, or an existing subprocess invocation. Declare every replacement network origin with `--allow-origin <origin>` when creating the session.
