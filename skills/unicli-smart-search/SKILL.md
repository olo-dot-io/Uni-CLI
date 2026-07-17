---
name: unicli-smart-search
description: >
  Route search queries to the best platform via unicli. Use when searching across
  websites, social media, tech forums, news, finance, shopping, or academic sources.
version: 1.1.0
triggers:
  - "search"
  - "find information"
  - "trending"
  - "hot topics"
  - "unicli search"
allowed-tools: [Bash]
protocol: 2.0
---

## When to Use

Searching for information, checking trending topics, or gathering data across platforms.
Commands return a v2 AgentEnvelope; pass `-f json` when you need JSON for parsing.

## Pre-Check

```bash
unicli search "<intent>"              # Discover from live registry first
unicli list --site <site>             # Verify subcommands exist
unicli <site> <command> --help        # Check args and output columns
```

## Search Routing

| Category     | Command                                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web**      | `unicli duckduckgo search <q>`, `unicli yahoo search <q>`, `unicli brave search <q>`, `unicli baidu search <q>`                                                                                                                         |
| **AI Infra** | `unicli ai profiles`, `unicli ai landscape`, `unicli ai pulse`, `unicli ai search <q>`, `unicli ai sources`, `unicli ai read <url>` — role-aware first-party labs, hardware, runtimes, model hubs, papers, code, talks, and communities |
| **Tech**     | `unicli hackernews top`, `unicli hackernews search <q>`, `unicli stackoverflow hot`, `unicli lobsters hot`, `unicli v2ex hot`, `unicli linux-do hot`                                                                                    |
| **Social**   | `unicli twitter search <q>`, `unicli twitter trending`, `unicli reddit search <q>`, `unicli reddit hot`, `unicli weibo hot`, `unicli zhihu hot`, `unicli tieba hot`, `unicli threads hot`                                               |
| **Finance**  | `unicli xueqiu hot`, `unicli xueqiu hot-stock`, `unicli binance hot`, `unicli eastmoney hot`, `unicli bloomberg markets`, `unicli yahoo-finance search <q>`                                                                             |
| **Academic** | `unicli arxiv search <q>`, `unicli arxiv paper <id>`                                                                                                                                                                                    |
| **Shopping** | `unicli amazon search <q>`, `unicli jd search <q>`, `unicli taobao search <q>`, `unicli smzdm hot`, `unicli xianyu search <q>`                                                                                                          |
| **Video**    | `unicli bilibili hot`, `unicli bilibili search <q>`, `unicli youtube search <q>`, `unicli tiktok search <q>`                                                                                                                            |
| **News**     | `unicli toutiao hot`, `unicli 36kr hot`, `unicli bbc hot`, `unicli cnn top`, `unicli nytimes top`, `unicli reuters top`                                                                                                                 |
| **Dev**      | `unicli github-trending`, `unicli producthunt hot`, `unicli docker-hub search <q>`                                                                                                                                                      |
| **Reading**  | `unicli douban search <q>`, `unicli douban top250`, `unicli weread ranking`, `unicli wikipedia search <q>`                                                                                                                              |
| **Jobs**     | `unicli boss search <q>`, `unicli linkedin search <q>`, `unicli maimai search <q>`                                                                                                                                                      |

## Multi-Source Pattern

For comprehensive research, query 2-3 complementary sources:

```bash
# Tech topic
unicli hackernews search "LLM agents" --limit 10
unicli reddit search "LLM agents" --limit 10
unicli arxiv search "LLM agents" --limit 5

# Current AI infrastructure evidence with normalized provenance
unicli ai profiles -f json
unicli ai landscape --profile world-models -f json
unicli ai pulse --profile inference --window week -f json
unicli ai pulse --profile world-models --window day --include-auth -f json
unicli ai search "CUDA ROCm CANN release notes" --vendors nvidia,amd,huawei-ascend -f json
unicli ai search "interactive generative environment" --profile world-models --sort latest -f json
unicli ai search "distributed inference" --repo vllm-project/vllm --kind community -f json
unicli ai search "ROCm" --sources hf --kind model -f json
unicli ai search "inference runtime" --sort latest --since 2026-01-01 -f json
unicli ai read "https://rocm.docs.amd.com/en/latest/about/release-notes.html" -f json

# Chinese trending
unicli weibo hot --limit 20
unicli zhihu hot --limit 20

# Market research
unicli producthunt hot --limit 10
unicli hackernews search "startup" --limit 10
```

## Output Handling

```bash
unicli hackernews top --limit 5 -f json | jq '.data[].title'
unicli xueqiu hot -f json | jq '.data[] | {name, change}'
```

## Fallback

- Exit 77 -> execute the envelope's exact `next_actions`; executable-native auth such as GitHub uses `gh auth login` / `gh auth status`, while cookie/browser strategies use `unicli auth import <site> --domain <domain>` or `unicli browser cookies <domain> --profile-id <id>`
- Exit 69 -> `unicli browser doctor --json`, `unicli browser doctor --repair`, then retry
- Exit 66 from `ai search` -> follow `next_actions`; broaden the query/source scope, or remove `--since` only when the envelope says candidates lacked verifiable timestamps
- `--since` is strict: dated source fields and explicitly prefixed search-index dates carry `timestamp_origin`; undated records are excluded rather than guessed, then `ai read <url>` refreshes the canonical candidate
- Partial `unicli ai search` failure -> successful sources remain in `data`; `partial_failure_count` is on every row and `data[0].source_errors` carries each exact retry command once
- Adapter failure -> classify `error.code`; auth/network/rate-limit errors stay at their owning boundary, while selector/schema/endpoint drift is edited from `adapter_path` and then verified with `unicli repair <site> <command>`
- Site down -> switch to alternative from routing table

## Budget

Per question: 1-2 primary sources + 1 supplementary. Do not query same site twice.
