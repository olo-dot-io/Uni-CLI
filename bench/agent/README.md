# Agent Bench — TC0 ASR Harness

Measures agent success rate (ASR) on unicli invocations under controlled
payload complexity (TC0, our Toolcall-Complexity score). The thesis: as
payload complexity rises, **JSON-in-stdin** beats **shell-quoted args**
for Transformer-based LLMs. The thesis is provider-agnostic, so this
harness drives the measurement across any OpenAI-compatible endpoint via
the Vercel AI SDK.

## What it runs

```
5 tasks × 4 ICS buckets × 3 channels × 10 trials × N models
= 600 trials per model
```

Tasks: `hackernews top`, `hackernews search`, `github search`, `arxiv
search`, `bilibili popular`.

Channels: `shell` (shell-quoted args), `file` (args JSON on disk),
`stdin` (args JSON piped).

ICS buckets: `trivial` → `moderate` → `hostile` → `pathological`.

## Providers supported

Anything that speaks the OpenAI Chat Completions protocol works via
`@ai-sdk/openai-compatible`. Verified for:

| Provider             | `BENCH_BASE_URL`                        | Notes                |
| -------------------- | --------------------------------------- | -------------------- |
| OpenRouter (default) | `https://openrouter.ai/api/v1`          | proxies 100+ models  |
| OpenAI direct        | `https://api.openai.com/v1`             | use OpenAI model ids |
| DeepSeek direct      | `https://api.deepseek.com/v1`           |                      |
| Moonshot / Kimi      | `https://api.moonshot.cn/v1`            |                      |
| Zhipu / GLM          | `https://open.bigmodel.cn/api/paas/v4/` |                      |
| Ollama local         | `http://localhost:11434/v1`             | no API key needed    |

## Env var contract

| Var                     | Default                                                               | Purpose                                                       |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `BENCH_API_KEY`         | **required**                                                          | Provider API key (OpenRouter recommended). Missing → exit 77. |
| `BENCH_BASE_URL`        | `https://openrouter.ai/api/v1`                                        | Override for non-OpenRouter endpoints.                        |
| `BENCH_MODELS`          | `deepseek/deepseek-chat,anthropic/claude-haiku-4-5,openai/gpt-5-mini` | Comma-separated model ids.                                    |
| `BENCH_TRIALS_PER_CELL` | `10`                                                                  | Trials per (task × bucket × channel) cell.                    |
| `BENCH_AUTOAPPROVE`     | unset                                                                 | `=1` skips the cost-confirm prompt. Required in non-TTY.      |

## Cost estimate (default 3-model × 600-trial run)

At ~500 input + ~120 output tokens per trial:

| Model                        | Input $/M | Output $/M | Cost per 600 trials |
| ---------------------------- | --------: | ---------: | ------------------: |
| `deepseek/deepseek-chat`     |     $0.27 |      $1.10 |              ~$0.16 |
| `anthropic/claude-haiku-4-5` |     $0.25 |      $1.25 |              ~$0.17 |
| `openai/gpt-5-mini`          |     $0.25 |      $2.00 |              ~$0.22 |

**Total: ~$0.54** for 1800 trials across 3 models. Preview the number
with `--estimate-only`.

Unknown models fall back to `$1.00/M in`, `$3.00/M out`.

## Commands

```bash
# Preview cost (no API call, no key required beyond "not-empty")
BENCH_API_KEY=dry-run npx tsx bench/agent/sdk-runner.ts --estimate-only

# Real run (after `npm run build`)
export BENCH_API_KEY=sk-or-...
export BENCH_AUTOAPPROVE=1
npm run bench:agent
npm run bench:gate
```

## Ship-gate thresholds (bench-v3)

A result passes iff:

- `summary_overall.asr_sem_at_ics8_stdin_avg ≥ 0.95`
- `summary_overall.sed_at_ics8_avg ≥ 0.30`
- `summary_overall.asr_sem_at_ics2_shell_avg ≥ 0.90`
- `summary_overall.models_passing_gate ≥ 2`

Each model is also checked individually against the same three numeric
thresholds; `models_passing_gate` counts how many pass.

## Output schema (`bench/agent/results.json`)

```jsonc
{
  "schema_version": "bench-v3",
  "provider": "openrouter",
  "base_url": "https://openrouter.ai/api/v1",
  "models": [
    "deepseek/deepseek-chat",
    "anthropic/claude-haiku-4-5",
    "openai/gpt-5-mini",
  ],
  "total_trials": 1800,
  "total_cost_usd": 0.54,
  "by_model": {
    "deepseek/deepseek-chat": {
      "rows": [
        /* per (task × bucket) row with ICS + channel rates */
      ],
      "summary": {
        "asr_sem_at_ics8_stdin": 0.96,
        "sed_at_ics8": 0.41,
        "asr_sem_at_ics2_shell": 0.91,
        "cost_usd": 0.154,
        "retries": 2,
        "wall_time_minutes": 6.3,
        "passes_gate": true,
      },
    },
    /* ... one entry per model ... */
  },
  "summary_overall": {
    "asr_sem_at_ics8_stdin_avg": 0.955,
    "sed_at_ics8_avg": 0.38,
    "asr_sem_at_ics2_shell_avg": 0.91,
    "models_passing_gate": 3,
    "models_total": 3,
  },
}
```

## Files

| File                            | Purpose                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `sdk-runner.ts`                 | Main multi-model corpus driver                                |
| `sdk-judges.ts`                 | Per-trial gen/exec/sem verdicts (pure, offline-unit-testable) |
| `sdk-aggregate.ts`              | Per-cell rates + Wilson 95% CIs + per-model summary           |
| `sdk-report.ts`                 | Multi-model envelope + gate-pass folding                      |
| `pricing.ts`                    | Per-model USD-per-1M table with fallback                      |
| `ics.ts` + `payload-factory.ts` | Payload corpus generator at controlled ICS                    |
| `report.ts`                     | Quick (non-LLM) bench variant, used as CI-cheap sanity        |

## Why the Vercel AI SDK

- Speaks OpenAI Chat Completions → works with OpenRouter, DeepSeek,
  Zhipu, Moonshot, Ollama without per-provider SDK churn.
- Native tool-use + `stopWhen: stepCountIs(4)` for bounded agent loops.
- `usage.inputTokens` / `usage.outputTokens` returned per call →
  accurate per-trial cost from `pricing.ts`.
- One dependency (`ai` + `@ai-sdk/openai-compatible`) instead of one SDK
  per provider.
