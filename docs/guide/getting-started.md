# Getting Started

Uni-CLI turns websites, logged-in browsers, desktop apps, services, local
tools, files, protocols, external CLIs, operating-system capabilities, and
visual evidence into governed operations agents can search, run, record, and
repair.

An operation is a stable contract for controlling real software. It keeps
arguments, auth posture, action substrate, output shape, permission profile,
evidence, and error handling in one place. When an external page, app, API, or
local boundary changes, the failure points back to a repairable source path and
step.

## Install

```bash
npm install -g @zenalexa/unicli
unicli --version
```

Requires Node.js 22.19 or later.

Every command follows the same shape:

```bash
unicli SITE COMMAND [args] [-f json|md|yaml|csv|compact]
```

Markdown is the default output format. Use `-f json` when a script or other
machine-oriented consumer needs JSON.

## Understand The Flow

The common path follows the computer-control loop:

1. **Intent**: `unicli search` finds candidate operations from natural language
   without touching the external surface.
2. **Select**: the operation contract chooses the smallest substrate that can
   act: API, browser, desktop, subprocess, protocol, or visual fallback.
3. **Govern and act**: `unicli SITE COMMAND` runs the selected operation with
   inspectable arguments, auth boundaries, and permission policy.
4. **Observe**: every result returns a v2 `AgentEnvelope` with data, context,
   retryability, timing, and evidence.
5. **Record**: `--record` or `UNICLI_RECORD_RUN=1` can write append-only run
   traces under `~/.unicli/runs` for review and debugging.
6. **Repair or reroute**: structured failures include the source path, failing
   step or boundary, suggestion, retryability, and alternatives.

Browser automation, CDP, accessibility trees, subprocesses, service APIs, MCP,
ACP, and Visual are action substrates. The stable layer is the operation
contract, control kernel, evidence envelope, and delivery/repair loop.

## Find A Command

```bash
unicli search "hacker news frontpage"
unicli search "github trending"
unicli list --site hackernews
```

Search narrows the candidate set. Before execution, the agent can still inspect
the command name, arguments, auth requirements, and surface type. That keeps
"found a possible operation" separate from "performed the operation."

## Run A Command

Run the selected command:

```bash
unicli hackernews top --limit 5
```

The default Markdown output contains data, context, and suggested next actions.
It is meant to stay readable in terminals, chat transcripts, and agent logs.

Use JSON when a script needs it:

```bash
unicli hackernews top --limit 5 -f json | jq '.[0]'
```

Supported formats and automatic selection:

```bash
unicli hackernews top -f md
unicli hackernews top -f json
unicli hackernews top -f yaml
unicli hackernews top -f csv
unicli hackernews top -f compact
```

Priority is `-f` flag, then `UNICLI_OUTPUT`, then agent/non-TTY detection, then
Markdown. Agent UA variables include `CLAUDE_CODE`, `CODEX_CLI`, `OPENCODE`,
`HERMES_AGENT`, and `UNICLI_AGENT`.

## Authentication

Some adapters need local cookies:

```bash
unicli auth setup bilibili
unicli auth check bilibili
unicli bilibili feed
```

Cookies live at `~/.unicli/cookies/SITE.json`. Auth failures return exit
code `77` and a structured error with the next command to run.

## Repair A Broken Command

When a command fails, read the structured error. It includes the adapter path
and pipeline step that need attention.

```bash
unicli repair SITE COMMAND
```

Typical loop:

```text
1. Read error.adapter_path and error.step.
2. Patch the YAML adapter.
3. Save a local override under ~/.unicli/adapters/SITE/COMMAND.yaml.
4. Re-run unicli repair SITE COMMAND.
```

The goal is not to retry until it works. The goal is to make the command match
its public output shape again. YAML adapters are usually short enough for agents
to read, patch, diff, and verify; use TypeScript adapters only when the runtime
logic cannot stay declarative.

## Browser Automation

Browser adapters use Chrome/CDP when HTTP is not enough.

```bash
unicli operate goto "https://example.com"
unicli operate snapshot
unicli operate click --ref 42
unicli operate type --ref 7 --text "hello"
unicli operate screenshot --path ./page.png
```

Browser actions can attach before/after evidence, stale-ref detail, movement
dimensions, watchdog results, session lease metadata, tab target identity,
cookie posture, and render-aware reads when a command needs reviewable proof.
When score thresholds are set, replay and compare output a `gate` object with
the thresholds, actual scores, and failed gates.
The score block also lists failed or unknown behavior and context check names.
Evidence coverage is context too: missing screenshots, operator logs, or result
envelopes show up as evidence check names.
`unicli runs list` also shows `evidence_count` and `evidence_by_type`, so an
agent can pick runs with reviewable proof before opening the trace.

```bash
unicli browser evidence --render-aware --expect-domain example.com
unicli browser extract --render-aware --expect-domain example.com --no-screenshot
unicli runs list
unicli runs show <run_id>
unicli runs probe <run_id>
unicli runs replay <run_id> --permission-profile confirm --yes --min-score 1 --min-context-score 1 --min-overall-score 1
unicli runs compare <run_id> <replay_run_id> --min-score 1 --min-context-score 1 --min-overall-score 1
unicli --permission-profile locked --yes --remember-approval word set-font "Inter"
unicli approvals list
unicli approvals revoke <approval_key>
```

Remembered approvals are bound to the command capability and stable resource
metadata, such as domain, app, account surface, and path argument slots. Runtime
argument values stay out of the approval store.

Use local deny rules for scopes that a machine must block:

```json
{
  "schema_version": "1",
  "rules": [
    {
      "id": "deny-public-posting",
      "decision": "deny",
      "match": {
        "effect": "publish_content",
        "resources": {
          "domains": ["x.com", "twitter.com"]
        }
      },
      "reason": "Publishing is disabled on this machine"
    }
  ]
}
```

Save the file as `~/.unicli/permission-rules.json`, or point
`UNICLI_PERMISSION_RULES_PATH` at it.

The same rules run again inside the pipeline for runtime resources. A denied
domain stops `fetch`, `fetch_text`, `download`, and browser `navigate` before
the request is sent. A denied path stops downloads and command output files
before the directory or file is created. A denied executable stops `exec` before
the subprocess starts.

## Protocol Servers

MCP:

```bash
npx @zenalexa/unicli mcp serve
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
npx @zenalexa/unicli mcp serve --transport streamable --port 19826 --auth
```

`--transport sse` still works as a legacy alias for Streamable, but new
deployments should use `--transport streamable`.

ACP:

```bash
unicli acp
```

ACP is an editor compatibility gateway. For coding-agent runtime routing:

```bash
unicli agents matrix
unicli agents recommend codex
unicli agents generate --for codex
```

## Exit Codes

| Code | Meaning             | Agent action                             |
| ---- | ------------------- | ---------------------------------------- |
| 0    | Success             | Use the data                             |
| 66   | Empty result        | Try different parameters                 |
| 69   | Service unavailable | Retry later                              |
| 75   | Temporary failure   | Retry with backoff                       |
| 77   | Auth required       | Run `unicli auth setup SITE`             |
| 78   | Config error        | Read the error envelope and adapter YAML |

## Next Steps

- [Adapters](/guide/adapters)
- [Integrations](/guide/integrations)
- [Self-Repair](/guide/self-repair)
- [Pipeline Steps](/reference/pipeline)
- [Exit Codes](/reference/exit-codes)
