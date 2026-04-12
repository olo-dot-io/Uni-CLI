---
name: unicli-smart-search
description: >
  Route search queries to the best platform via unicli. Use when searching across
  websites, social media, tech forums, news, finance, shopping, or academic sources.
version: 1.0.0
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
All commands return structured JSON when piped.

## Pre-Check

```bash
unicli <site> --help                  # Verify subcommands exist
unicli <site> <command> --help        # Check args and output columns
```

## Search Routing

| Category | Command |
|----------|---------|
| **Web** | `unicli google search <q>`, `unicli baidu search <q>` |
| **Tech** | `unicli hackernews top`, `unicli hackernews search <q>`, `unicli stackoverflow hot`, `unicli lobsters hot`, `unicli v2ex hot`, `unicli linux-do hot` |
| **Social** | `unicli twitter search <q>`, `unicli twitter trending`, `unicli reddit search <q>`, `unicli reddit hot`, `unicli weibo hot`, `unicli zhihu hot`, `unicli tieba hot`, `unicli threads hot` |
| **Finance** | `unicli xueqiu hot`, `unicli xueqiu hot-stock`, `unicli binance hot`, `unicli eastmoney hot`, `unicli bloomberg markets`, `unicli yahoo-finance search <q>` |
| **Academic** | `unicli arxiv search <q>`, `unicli arxiv paper <id>` |
| **Shopping** | `unicli amazon search <q>`, `unicli jd search <q>`, `unicli taobao search <q>`, `unicli smzdm hot`, `unicli xianyu search <q>` |
| **Video** | `unicli bilibili hot`, `unicli bilibili search <q>`, `unicli youtube search <q>`, `unicli tiktok search <q>` |
| **News** | `unicli toutiao hot`, `unicli 36kr hot`, `unicli bbc hot`, `unicli cnn top`, `unicli nytimes top`, `unicli reuters top` |
| **Dev** | `unicli github-trending`, `unicli producthunt hot`, `unicli docker-hub search <q>` |
| **Reading** | `unicli douban search <q>`, `unicli douban top250`, `unicli weread ranking`, `unicli wikipedia search <q>` |
| **Jobs** | `unicli boss search <q>`, `unicli linkedin search <q>`, `unicli maimai search <q>` |

## Multi-Source Pattern

For comprehensive research, query 2-3 complementary sources:

```bash
# Tech topic
unicli hackernews search "LLM agents" --limit 10
unicli reddit search "LLM agents" --limit 10
unicli arxiv search "LLM agents" --limit 5

# Chinese trending
unicli weibo hot --limit 20
unicli zhihu hot --limit 20

# Market research
unicli producthunt hot --limit 10
unicli hackernews search "startup" --limit 10
```

## Output Handling

```bash
unicli hackernews top --limit 5 | jq '.[].title'
unicli xueqiu hot | jq '.[] | {name, change}'
```

## Fallback

- Exit 77 -> `unicli auth setup <site>` then retry
- Exit 69 -> `unicli browser start` then retry
- Exit 66 -> try different query terms
- Site down -> switch to alternative from routing table

## Budget

Per question: 1-2 primary sources + 1 supplementary. Do not query same site twice.
