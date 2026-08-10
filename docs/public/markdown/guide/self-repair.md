<!-- Generated from docs/guide/self-repair.md. Do not edit this copy directly. -->

# Self-Repair

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/self-repair
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/self-repair.md
- Section: Use Uni-CLI
- Parent: Use Uni-CLI (/guide/)

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

Use an evolution session when one successful replay is too weak to justify a persistent override. Record separate proposal, validation, and held-out runs.

```bash
unicli --record <site> <command> [args]
unicli runs list -f json

unicli evolve adapter <site> <command> \
  --run <proposal-run> \
  --validation-run <validation-run> \
  --held-out-run <held-out-run> \
  -f json
```

The returned session names `candidate.path`. An Agent can edit that isolated YAML file or pass an existing candidate through `--candidate <path>`. Proposal evidence contains trace references and redacted failure summaries. It excludes replay arguments and secret event fields.

```bash
unicli evolve diff <session-id> -f json
unicli evolve verify <session-id> -f json
unicli evolve promote <session-id> -f json
```

The gate keeps the baseline when the candidate is unchanged, validation does not strictly improve, any validation case regresses, held-out evaluation is empty, or a held-out case regresses. `promote` writes `~/.unicli/adapters/<site>/<command>.yaml`. `rollback` restores the pre-promotion overlay and stops if that file has changed since promotion.

Read-only operations can run through the gate by default. Use `--allow-mutation-eval` only when every validation target is an intended controlled environment. A candidate may repair endpoints, selectors, extraction, and pipeline behavior, but it cannot change the session's authorization or execution-scope fields.
