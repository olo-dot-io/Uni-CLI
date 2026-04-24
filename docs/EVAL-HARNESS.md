# Eval Harness

> Declarative regression suites for Uni-CLI adapters.

## What it does

`unicli eval` runs YAML-defined eval suites against adapters and reports `SCORE=N/M`. The harness ships 15 starter evals out of the box (12 smoke + 3 regression) and discovers user-local evals from `~/.unicli/evals/`.

## Why

Adapter repair needs measurable baselines. Eval files are the simplest
regression test: an adapter that suddenly returns `[]`, 403, or malformed data
fails its eval immediately.

## Commands

```bash
# List discovered eval files
unicli eval list

# Run one eval file
unicli eval run smoke/hackernews

# Run all evals in a subdirectory
unicli eval run --all smoke/

# Run only adapters touched in the last 7 days (CI mode)
unicli eval ci --since 7d

# JSON output for CI integration
unicli eval run smoke/hackernews --json
```

## File format

```yaml
name: hackernews-smoke
adapter: hackernews
description: Hacker News public-API smoke test
cases:
  - command: top
    args:
      limit: 5
    judges:
      - { type: arrayMinLength, min: 5 }
      - { type: nonEmpty }
  - command: search
    positional: [ai]
    args:
      limit: 3
    judges:
      - { type: arrayMinLength, min: 1 }
      - { type: contains, value: "ai" }
```

### Judges

| Type             | Fields                        | Passes when                                               |
| ---------------- | ----------------------------- | --------------------------------------------------------- |
| `exitCode`       | `equals: 0`                   | The CLI exit code matches                                 |
| `nonEmpty`       | —                             | Raw output is non-whitespace                              |
| `matchesPattern` | `pattern: "regex"`            | Raw output matches the regex                              |
| `contains`       | `field?: "json.path", value:` | The (resolved) value contains the substring               |
| `arrayMinLength` | `path?: "json.path", min:`    | The (resolved) value is an array of at least `min` length |

### Path syntax

Field/path values use dotted-path syntax with `[N]` array subscripts:

```
data.items[0].title
results[3].author
```

## Bundled evals

```
evals/
├── smoke/
│   ├── bilibili.yaml      hackernews.yaml   reddit.yaml
│   ├── twitter.yaml       weibo.yaml        zhihu.yaml
│   ├── xiaohongshu.yaml   douyin.yaml       youtube.yaml
│   ├── instagram.yaml     linkedin.yaml     hupu.yaml
│   ├── douban.yaml        producthunt.yaml  github.yaml
└── regression/
    ├── auth-rotation.yaml
    ├── selector-drift.yaml
    └── api-versioning.yaml
```

## CI integration

The CI mode runs evals only for adapters touched within a recent git window — keeps PR latency low while still catching the regressions that matter most:

```bash
unicli eval ci --since 7d --json
# {"matched":3,"score":7,"total":7}
```

Exit code: 0 on `score == total`, 1 otherwise. Wire this into the same `npm run verify` step or a separate `npm run eval:ci` script.

## Writing your own evals

Drop a `.yaml` file into `~/.unicli/evals/` and `unicli eval list` will pick it up. The file format is identical to the bundled evals.
