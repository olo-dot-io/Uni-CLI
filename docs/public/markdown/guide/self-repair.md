<!-- Generated from docs/guide/self-repair.md. Do not edit this copy directly. -->

# Self-Repair

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/self-repair
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/self-repair.md
- Section: Guides
- Parent: Guides (/guide/)

The web breaks constantly. Selectors change, APIs version, auth tokens rotate,
desktop permission channels disappear, and CLIs change flags. Uni-CLI is
designed to fail as data, not as an opaque log line.

## The Problem

Traditional scrapers and API wrappers fail silently or catastrophically when the target changes. The fix cycle is slow: notice failure, read logs, find the change, edit code, test, deploy.

Uni-CLI compresses this cycle by making adapters readable, errors structured
as v2 `AgentEnvelope` objects, and fixes persistent through the
`~/.unicli/adapters/` overlay.

## Repair Levels

### Level 0: Auto-Retry

Transient failures (network timeouts, rate limits, 5xx errors) are retried automatically with exponential backoff.

```
Request failed (503) → wait 1s → retry → wait 2s → retry → wait 4s → retry → give up
```

Configuration is per-step in the pipeline:

```yaml
pipeline:
  - fetch:
      url: "https://api.example.com/data"
      retry: 3
      backoff: exponential
```

Exit code `75` (temporary failure) signals the agent to retry the entire command later.

### Level 1: Auto-Fix

When a pipeline step fails, the engine preserves enough failure context for the
next actor:

- **Selector miss**: a CSS selector or JSON path matched nothing.
- **Empty result**: the upstream returned data but the adapter projected none of it.
- **Schema change**: expected fields are missing or renamed.
- **Auth/permission failure**: cookies, local app automation, or platform permissions are unavailable.

These diagnostics appear in the structured error output, giving the next level
(agent-assisted repair) a bounded starting point.

### Level 2: Agent-Assisted

This is Uni-CLI's core differentiator. When a command fails, the error is emitted as a structured envelope:

```json
{
  "ok": false,
  "schema_version": "2",
  "command": "bilibili.feed",
  "meta": { "duration_ms": 82 },
  "data": null,
  "error": {
    "code": "selector_miss",
    "message": "select path returned no rows",
    "adapter_path": "/Users/you/.unicli/adapters/bilibili/feed.yml",
    "step": 3,
    "suggestion": "Try: select: data.result.feeds",
    "retryable": false,
    "alternatives": ["bilibili.search"]
  }
}
```

An AI agent reads this error, opens the 20-line YAML at `adapter_path`, applies the fix, and retries:

```
unicli bilibili feed
  → fails with structured error JSON
  → agent reads error: selector_miss at step 3
  → agent reads ~/.unicli/adapters/bilibili/feed.yml
  → agent changes "data.items" to "data.result.feeds"
  → agent runs: unicli bilibili feed
  → success
```

The fix persists in `~/.unicli/adapters/` and survives `npm update` because user-local adapters override built-in ones.

### Level 3: Community Fix

When many agents encounter the same failure, the fix propagates through the adapter registry:

1. Agent fixes a broken adapter locally
2. Agent submits the fix (PR or registry update)
3. Other users receive the fix via `npm update` or adapter sync

The `unicli repair` command helps diagnose issues:

```bash
unicli repair bilibili feed
```

This runs the adapter, catches the failure, and prints a detailed diagnostic report with the suggested fix.

### Level 4: AI Generation

For entirely new sites with no existing adapter, agents can generate one from scratch:

1. **Record**: `unicli record https://example.com` opens Chrome, records your interactions, and captures network requests.
2. **Generate**: The recording is translated into a YAML adapter draft.
3. **Test**: `unicli test example` verifies the generated adapter works.
4. **Iterate**: The agent refines the YAML based on test output.

## Structured Errors

Every error includes enough context for an agent to act without asking a human:

| Field                | Type    | Description                                                   |
| -------------------- | ------- | ------------------------------------------------------------- |
| `ok`                 | boolean | `false` for failures                                          |
| `schema_version`     | string  | Envelope schema, currently `"2"`                              |
| `command`            | string  | Fully qualified command, such as `bilibili.feed`              |
| `error.code`         | string  | Stable error code, such as `selector_miss` or `auth_required` |
| `error.message`      | string  | Human-readable failure detail                                 |
| `error.adapter_path` | string  | Adapter file to inspect                                       |
| `error.step`         | number  | Pipeline step index when known                                |
| `error.suggestion`   | string  | Actionable next step                                          |
| `error.retryable`    | boolean | Whether retrying the same command may help                    |
| `error.alternatives` | array   | Nearby commands to try                                        |

## Error Types

| Error code                            | Meaning                                 | Typical fix                                 |
| ------------------------------------- | --------------------------------------- | ------------------------------------------- |
| `selector_miss`                       | CSS selector or JSON path missed        | Update selector in YAML                     |
| `auth_required` / `not_authenticated` | Cookie/token missing or expired         | `unicli auth setup SITE`                    |
| `network_error`                       | Connection failed                       | Check network, retry later                  |
| `rate_limited`                        | Too many requests                       | Wait, add `rate_limit` or lower `limit`     |
| `unavailable`                         | Required local runtime is missing       | Install or grant permission                 |
| `invalid_input`                       | Argument failed validation              | Fix args or adapter schema                  |
| `internal_error`                      | Runtime bug or unhandled upstream shape | Run `unicli repair` and inspect the adapter |

## Repair Workflow

The `unicli repair` command automates diagnosis:

```bash
# Diagnose a specific command
unicli repair bilibili feed

# Test all commands for a site
unicli test bilibili

# Test all adapters
unicli test
```

`unicli repair` runs the command, catches the failure, and outputs a structured diagnostic that includes:

- The exact step that failed
- The current YAML configuration
- The actual response shape when available
- A suggested fix

## Design Principles

1. **Errors are data, not strings.** JSON to stderr, parseable by any agent.
2. **Adapters are small.** YAML-first adapters are short enough for an agent to inspect directly.
3. **Fixes are local.** `~/.unicli/adapters/` overrides survive updates. No fork needed.
4. **Exit codes are semantic.** `sysexits.h` codes tell agents _what kind_ of failure occurred.
5. **Suggestions are actionable.** "Try: select: data.result.feeds" — not "something went wrong."
