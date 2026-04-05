# Self-Repair

The web breaks constantly. Selectors change, APIs version, auth tokens rotate. Uni-CLI is designed to break gracefully and heal — with or without human intervention.

## The Problem

Traditional scrapers and API wrappers fail silently or catastrophically when the target changes. The fix cycle is slow: notice failure, read logs, find the change, edit code, test, deploy.

Uni-CLI compresses this cycle by making adapters readable (~20 lines of YAML), errors structured (machine-parseable JSON), and fixes persistent (survive updates).

## Five Levels of Healing

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

When a pipeline step fails, the engine analyzes the failure type and suggests fixes:

- **Selector miss**: A CSS selector matched nothing. The engine scans the DOM for similar selectors and suggests alternatives.
- **Empty result**: The API returned data but the `select` path found nothing. The engine shows the actual response structure.
- **Schema change**: Expected fields are missing. The engine diffs the expected vs actual shape.

These diagnostics appear in the structured error output, giving the next level (agent-assisted) a head start.

### Level 2: Agent-Assisted

This is Uni-CLI's core differentiator. When a command fails, the error is emitted as structured JSON to stderr:

```json
{
  "error": "selector_miss",
  "adapter_path": "/Users/you/.unicli/adapters/bilibili/feed.yml",
  "step": 3,
  "action": "select",
  "config": "data.items",
  "actual_keys": ["data.result.feeds"],
  "suggestion": "Try: select: data.result.feeds"
}
```

An AI agent reads this error, opens the 20-line YAML at `adapter_path`, applies the fix, and retries:

```
unicli bilibili feed
  → fails with structured error JSON
  → agent reads error: selector_miss at step 3
  → agent reads ~/.unicli/adapters/bilibili/feed.yml (20 lines)
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

| Field          | Type   | Description                                  |
| -------------- | ------ | -------------------------------------------- |
| `error`        | string | Error type: `selector_miss`, `auth_expired`, `network_error`, etc. |
| `adapter_path` | string | Absolute path to the YAML file               |
| `step`         | number | Pipeline step index (0-based)                |
| `action`       | string | Step action name (`fetch`, `select`, etc.)   |
| `config`       | any    | The step configuration that failed           |
| `suggestion`   | string | Human/agent-readable fix suggestion          |
| `actual_keys`  | array  | Available keys when a `select` path misses   |

## Error Types

| Error Type        | Meaning                           | Typical Fix                       |
| ----------------- | --------------------------------- | --------------------------------- |
| `selector_miss`   | CSS selector or JSON path missed  | Update selector in YAML           |
| `auth_expired`    | Cookie/token no longer valid      | `unicli auth setup <site>`        |
| `network_error`   | Connection failed                 | Check network, retry later        |
| `rate_limited`    | Too many requests                 | Wait, add `rate_limit` step       |
| `schema_change`   | Response shape changed            | Update `select` and `map` steps   |
| `binary_missing`  | Desktop CLI not installed         | Install the binary                |
| `parse_error`     | Response is not valid JSON/HTML   | Check URL, add `fetch_text` step  |

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
- The actual response from the server
- A suggested fix

## Design Principles

1. **Errors are data, not strings.** JSON to stderr, parseable by any agent.
2. **Adapters are small.** ~20 lines of YAML. An agent can read the entire adapter in a single context window.
3. **Fixes are local.** `~/.unicli/adapters/` overrides survive updates. No fork needed.
4. **Exit codes are semantic.** `sysexits.h` codes tell agents _what kind_ of failure occurred.
5. **Suggestions are actionable.** "Try: select: data.result.feeds" — not "something went wrong."
