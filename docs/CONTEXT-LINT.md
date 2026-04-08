# Context Lint

> Static-analyze AGENTS.md / CLAUDE.md / skills / docs for staleness and quality.

## What it does

`scripts/lint-context.sh` runs Agent Lint against the Uni-CLI workspace and gates `npm run verify` on the result. Each context artifact (skill, agent file, workflow, doc) gets scored on Agent Lint's 12 quality dimensions, and any artifact below the threshold (default 60/100) fails verify.

## Why

Bad context = bad code. The `AGENTS.md`, `CLAUDE.md`, skills, and docs are the operating system of any coding agent that ships with Uni-CLI. When they drift behind the codebase — references to renamed files, removed flags, dead commands — the agent's first response makes things worse, not better. Context lint catches this drift the same way ESLint catches `let x = undefined; x.foo`.

## Resolution order

The script tries the following, in order:

1. `agent-lint` on `PATH` (globally installed via `npm i -g @agent-lint/cli`)
2. `ref/agentlint/packages/cli/dist/index.js` (vendored + built)
3. **Soft skip** with a warning — does NOT fail verify

We deliberately do **not** fall back to `npx @agent-lint/cli`, because npx will silently fetch from the network during `npm run verify`. Explicit installation paths are easier to audit.

## Threshold gate

The default threshold is 60. Override per-run via `UNICLI_LINT_THRESHOLD`:

```bash
UNICLI_LINT_THRESHOLD=80 npm run lint:context
```

Threshold checking requires `jq` to parse Agent Lint's JSON output. Without `jq`, the script prints the raw output and exits 0 (soft pass).

## Disabling

To skip context lint entirely (e.g. for a CI runner that has no Node):

```bash
UNICLI_LINT_DISABLE=1 npm run verify
```

## Wiring

The verify script in `package.json`:

```json
"verify": "npm run format:check && npm run typecheck && npm run lint && npm run lint:context && npm run test && npm run build"
```

`lint:context` runs after the source-level lint and before the test pass — it's cheap, deterministic, and surfaces context drift early.

## The 12 quality dimensions

Agent Lint scores each artifact against its rubric:

| Category  | Dimensions                                                              |
| --------- | ----------------------------------------------------------------------- |
| Skills    | Purpose / Scope / Inputs / Steps / Verification / Safety                |
| Agents    | Do / Don't / Verification / Security / Commands                         |
| Workflows | Goal / Preconditions / Inputs / Steps / Outputs / Errors / Verification |

A skill missing "Verification" or an agents file missing "Don't" is exactly the kind of drift that produces broken bash one-liners. The lint catches them.
