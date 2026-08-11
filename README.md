<p align="center">
  <img src="assets/mascot-otter.png" alt="Uni-CLI otter mascot" width="112">
</p>

<h1 align="center">Uni-CLI</h1>

<p align="center">
  <strong>Give agents every interface</strong><br>
  Install once. Search, run, inspect, repair.
</p>

<p align="center">
  <a href="https://olo-dot-io.github.io/Uni-CLI/">Website</a>&nbsp;&nbsp;
  <a href="https://olo-dot-io.github.io/Uni-CLI/reference/sites">Operations</a>&nbsp;&nbsp;
  <a href="https://www.npmjs.com/package/@zenalexa/unicli">npm</a>&nbsp;&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@zenalexa/unicli"><img alt="npm version" src="https://img.shields.io/npm/v/@zenalexa/unicli?style=flat-square&color=0A6244"></a>
  <a href="./LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-073F2B?style=flat-square"></a>
  <img alt="Node 22.19 or newer" src="https://img.shields.io/badge/node-22.19%2B-D86A35?style=flat-square">
</p>

<p align="center">
  <img src="docs/public/site-preview.webp" alt="Uni-CLI green observatory hero with one-click npm and agent prompt copy" width="100%">
</p>

Uni-CLI turns intent into a selected operation and a structured receipt across web, browser, desktop, local, and MCP surfaces.

```bash
npm install -g @zenalexa/unicli
unicli search "list the top Hacker News stories"
unicli hackernews top --limit 3 -f json
```

Check releases or open an interactive Y/N update choice.

```bash
unicli upgrade --check -f json
unicli upgrade
```

Persistent non-interactive Agent installations update in a detached worker by default. Structured output reports progress through `meta.update.automatic_update`. Interactive terminals keep the Y/N choice, and `unicli upgrade --no-auto-update` switches a machine back to explicit approval.

## Route By Task

The catalog handles discovery and operation contracts. Execution then selects the strongest operator with the smallest effective scope. One provider runs; a failed path keeps its original cause and repair command.

| Task boundary                          | Execution operator  | Why                                                                 |
| -------------------------------------- | ------------------- | ------------------------------------------------------------------- |
| Public data or stable service contract | Structured API      | Typed fields, explicit auth, stable provenance                      |
| Files, system state, local tools       | Local runtime       | Direct process and OS boundaries without browser state              |
| Authenticated or private web contract  | Browser protocol    | Explicit profile, cookie session, or network contract               |
| Page-only web flow                     | Semantic browser    | DOM and CDP semantics with an explicit target and session           |
| Native desktop application             | Accessibility       | Structured AX, UIA, or AT-SPI control trees                         |
| Pixel-only or unstructured interface   | Visual computer use | Coordinate and visual observation when no stronger interface exists |

```bash
unicli search "export my saved posts"     # discover and rank
unicli list --site reddit                  # inspect one surface
unicli browser doctor --json               # inspect browser delivery state
unicli repair reddit saved                 # verify a supported drift path
```

## The Operation Contract

The public model stays compact.

```text
intent → candidate operations → explicit selection → policy → substrate → receipt
```

| Stage    | Runtime behavior                                                                           |
| -------- | ------------------------------------------------------------------------------------------ |
| Discover | Compiled intent and bilingual retrieval return a small ranked set with selection evidence  |
| Select   | The caller chooses one operation with a declared strategy and substrate                    |
| Govern   | `open`, `confirm`, and `locked` profiles evaluate effect and capability scope              |
| Act      | The selected adapter, core command, browser, desktop, or protocol path executes            |
| Observe  | Every normal command returns a stable success or error envelope                            |
| Repair   | Owned drift paths expose their source, failed boundary, and bounded verification command   |
| Evolve   | Recorded failures become isolated candidates that must pass paired and held-out evaluation |

Uni-CLI supplies the interface runtime. The model, planner, agent loop, and sandbox remain independent choices.

## Surfaces

| Surface   | Current runtime                                                                              |
| --------- | -------------------------------------------------------------------------------------------- |
| Web       | Public data, cookies, headers, downloads, uploads, publishing, search, and Chinese platforms |
| Browser   | CDP navigation, semantic action, network, snapshots, screenshots, and post-action evidence   |
| Desktop   | Native controls, macOS services, design tools, Office, and media applications                |
| Local     | Subprocess bridges, files, PDF and paper workflows, media transforms, and developer CLIs     |
| Protocols | Native CLI, MCP stdio, MCP Streamable HTTP, ACP, generated configs, and agent skills         |
| Policy    | Permission profiles, deny rules, scoped approvals, recordings, replay, and evidence          |

Static catalog

- <!-- STATS:site_count -->337<!-- /STATS --> sites
- <!-- STATS:command_count -->1890<!-- /STATS --> registered commands
- <!-- STATS:adapter_count_total -->1267<!-- /STATS --> adapters
- <!-- STATS:pipeline_step_count -->113<!-- /STATS --> pipeline actions
- <!-- STATS:test_count -->10336<!-- /STATS --> tests

Fixed core and host-discovered commands join at runtime.

<!-- BEGIN README_SITE_GRID -->
<!-- prettier-ignore -->
| Surface | Sites | Operations | Examples |
| --- | ---: | ---: | --- |
| social | 33 | 396 | [twitter](https://olo-dot-io.github.io/Uni-CLI/reference/sites#twitter), [zhihu](https://olo-dot-io.github.io/Uni-CLI/reference/sites#zhihu), [instagram](https://olo-dot-io.github.io/Uni-CLI/reference/sites#instagram), [reddit](https://olo-dot-io.github.io/Uni-CLI/reference/sites#reddit) |
| video | 8 | 75 | [tiktok](https://olo-dot-io.github.io/Uni-CLI/reference/sites#tiktok), [youtube](https://olo-dot-io.github.io/Uni-CLI/reference/sites#youtube), [bilibili](https://olo-dot-io.github.io/Uni-CLI/reference/sites#bilibili), [douyin](https://olo-dot-io.github.io/Uni-CLI/reference/sites#douyin) |
| news | 11 | 45 | [hackernews](https://olo-dot-io.github.io/Uni-CLI/reference/sites#hackernews), [bloomberg](https://olo-dot-io.github.io/Uni-CLI/reference/sites#bloomberg), [bbc](https://olo-dot-io.github.io/Uni-CLI/reference/sites#bbc), [36kr](https://olo-dot-io.github.io/Uni-CLI/reference/sites#36kr) |
| finance | 10 | 67 | [eastmoney](https://olo-dot-io.github.io/Uni-CLI/reference/sites#eastmoney), [xueqiu](https://olo-dot-io.github.io/Uni-CLI/reference/sites#xueqiu), [binance](https://olo-dot-io.github.io/Uni-CLI/reference/sites#binance), [coingecko](https://olo-dot-io.github.io/Uni-CLI/reference/sites#coingecko) |
| shopping | 13 | 47 | [amazon](https://olo-dot-io.github.io/Uni-CLI/reference/sites#amazon), [jd](https://olo-dot-io.github.io/Uni-CLI/reference/sites#jd), [taobao](https://olo-dot-io.github.io/Uni-CLI/reference/sites#taobao), [1688](https://olo-dot-io.github.io/Uni-CLI/reference/sites#1688) |
| dev | 37 | 185 | [codex](https://olo-dot-io.github.io/Uni-CLI/reference/sites#codex), [cursor](https://olo-dot-io.github.io/Uni-CLI/reference/sites#cursor), [gh](https://olo-dot-io.github.io/Uni-CLI/reference/sites#gh), [stackoverflow](https://olo-dot-io.github.io/Uni-CLI/reference/sites#stackoverflow) |
| ai | 25 | 215 | [chatgpt](https://olo-dot-io.github.io/Uni-CLI/reference/sites#chatgpt), [antigravity](https://olo-dot-io.github.io/Uni-CLI/reference/sites#antigravity), [chatwise](https://olo-dot-io.github.io/Uni-CLI/reference/sites#chatwise), [notebooklm](https://olo-dot-io.github.io/Uni-CLI/reference/sites#notebooklm) |
| scholarly | 30 | 105 | [openreview](https://olo-dot-io.github.io/Uni-CLI/reference/sites#openreview), [zotero](https://olo-dot-io.github.io/Uni-CLI/reference/sites#zotero), [pubmed](https://olo-dot-io.github.io/Uni-CLI/reference/sites#pubmed), [arxiv](https://olo-dot-io.github.io/Uni-CLI/reference/sites#arxiv) |
| patent | 17 | 42 | [epo](https://olo-dot-io.github.io/Uni-CLI/reference/sites#epo), [espacenet](https://olo-dot-io.github.io/Uni-CLI/reference/sites#espacenet), [cipo](https://olo-dot-io.github.io/Uni-CLI/reference/sites#cipo), [cnipa](https://olo-dot-io.github.io/Uni-CLI/reference/sites#cnipa) |
| reference | 12 | 47 | [marxists-cn](https://olo-dot-io.github.io/Uni-CLI/reference/sites#marxists-cn), [anilist](https://olo-dot-io.github.io/Uni-CLI/reference/sites#anilist), [bangumi](https://olo-dot-io.github.io/Uni-CLI/reference/sites#bangumi), [imdb](https://olo-dot-io.github.io/Uni-CLI/reference/sites#imdb) |
| audio | 4 | 46 | [spotify](https://olo-dot-io.github.io/Uni-CLI/reference/sites#spotify), [netease-music](https://olo-dot-io.github.io/Uni-CLI/reference/sites#netease-music), [xiaoyuzhou](https://olo-dot-io.github.io/Uni-CLI/reference/sites#xiaoyuzhou), [apple-podcasts](https://olo-dot-io.github.io/Uni-CLI/reference/sites#apple-podcasts) |
| content | 16 | 90 | [lesswrong](https://olo-dot-io.github.io/Uni-CLI/reference/sites#lesswrong), [danbooru](https://olo-dot-io.github.io/Uni-CLI/reference/sites#danbooru), [dlsite](https://olo-dot-io.github.io/Uni-CLI/reference/sites#dlsite), [weread](https://olo-dot-io.github.io/Uni-CLI/reference/sites#weread) |
| productivity | 10 | 78 | [notion-app](https://olo-dot-io.github.io/Uni-CLI/reference/sites#notion-app), [ones](https://olo-dot-io.github.io/Uni-CLI/reference/sites#ones), [obsidian](https://olo-dot-io.github.io/Uni-CLI/reference/sites#obsidian), [quark](https://olo-dot-io.github.io/Uni-CLI/reference/sites#quark) |
| jobs | 6 | 42 | [nowcoder](https://olo-dot-io.github.io/Uni-CLI/reference/sites#nowcoder), [boss](https://olo-dot-io.github.io/Uni-CLI/reference/sites#boss), [51job](https://olo-dot-io.github.io/Uni-CLI/reference/sites#51job), [linkedin](https://olo-dot-io.github.io/Uni-CLI/reference/sites#linkedin) |
| desktop | 25 | 201 | [macos](https://olo-dot-io.github.io/Uni-CLI/reference/sites#macos), [freecad](https://olo-dot-io.github.io/Uni-CLI/reference/sites#freecad), [blender](https://olo-dot-io.github.io/Uni-CLI/reference/sites#blender), [gimp](https://olo-dot-io.github.io/Uni-CLI/reference/sites#gimp) |
| games | 1 | 7 | [steam](https://olo-dot-io.github.io/Uni-CLI/reference/sites#steam) |
| utility | 7 | 29 | [linear](https://olo-dot-io.github.io/Uni-CLI/reference/sites#linear), [bitwarden](https://olo-dot-io.github.io/Uni-CLI/reference/sites#bitwarden), [todoist](https://olo-dot-io.github.io/Uni-CLI/reference/sites#todoist), [qweather](https://olo-dot-io.github.io/Uni-CLI/reference/sites#qweather) |
| other | 71 | 122 | [slay-the-spire-ii](https://olo-dot-io.github.io/Uni-CLI/reference/sites#slay-the-spire-ii), [xiaoe](https://olo-dot-io.github.io/Uni-CLI/reference/sites#xiaoe), [archive](https://olo-dot-io.github.io/Uni-CLI/reference/sites#archive), [ke](https://olo-dot-io.github.io/Uni-CLI/reference/sites#ke) |
| travel | 1 | 4 | [ctrip](https://olo-dot-io.github.io/Uni-CLI/reference/sites#ctrip) |

<!-- END README_SITE_GRID -->

The generated [operation catalog](https://olo-dot-io.github.io/Uni-CLI/reference/sites) is the authoritative inventory.

## Use It From An Agent

### Native CLI

```bash
unicli search "download the latest arXiv paper on computer use" -f json
unicli arxiv search "computer use agents" --limit 5 -f json
unicli --auth-retry openreview conference "ICML.cc/2026/Conference" --rpm 20 -f json
unicli extract https://example.com --max-chars 1200
```

Piped output defaults to Markdown. Use `-f json`, `yaml`, `csv`, or `compact` when the next step needs a stable machine format.
The [OpenReview archive guide](https://olo-dot-io.github.io/Uni-CLI/guide/openreview-archive)
covers authenticated, resumable conference and multi-year research archives.

### MCP

```json
{
  "mcpServers": {
    "unicli": {
      "command": "npx",
      "args": ["-y", "@zenalexa/unicli-mcp"]
    }
  }
}
```

Equivalent command

```bash
npx -y @zenalexa/unicli mcp serve
```

The default profile exposes four meta-tools. Deferred and expanded profiles project adapter operations when the host needs tool-level discovery. Inspect the live projection with `unicli mcp health -f json`.

### Local Computer

```bash
unicli compute apps --format compact
unicli compute snapshot --app Calculator --format compact
unicli compute find --app Calculator --role AXButton --title "7"
unicli compute click --ref <ref-from-find>
```

Desktop actions prefer accessibility references. Visual routes require an explicitly selected backend and never appear as a hidden fallback.

## Results That Explain Themselves

Success

```yaml
ok: true
schema_version: "2"
command: "hackernews.top"
meta:
  duration_ms: 412
  count: 3
  surface: web
data:
  - { rank: "1", title: "...", url: "...", author: "..." }
error: null
```

Failure

```yaml
ok: false
schema_version: "2"
command: "reddit.saved"
data: null
error:
  code: auth_required
  adapter_path: "src/adapters/reddit/saved.yaml"
  step: 1
  suggestion: "Run: unicli auth setup reddit"
  retryable: false
```

Exit codes distinguish success, empty results, unavailable dependencies, temporary failures, auth, and configuration. See the [output and exit-code reference](docs/reference/exit-codes.md).

## Repair Drift At The Owned Boundary

Adapters stay agent-readable and locally replaceable.

```text
run → read error.adapter_path → patch the owned step → save override → verify once
```

```bash
unicli repair <site> <command>
```

`repair` does not edit source or Git state. It reruns the original command as a bounded subprocess and succeeds only when the target returns `ok: true` with exit code `0`. Local overrides under `~/.unicli/adapters/` survive npm updates.

For repeated failures, `evolve adapter` keeps proposal evidence, validation, and held-out cases separate. The agent supplies one isolated YAML candidate and a falsifiable prediction. Uni-CLI runs paired baseline and candidate evaluations, records prediction misses and regressions, and installs a user override only after the promotion gate passes.

```bash
unicli evolve adapter <site> <command> \
  --run <proposal-run> \
  --candidate <candidate.yaml> \
  --hypothesis "<expected mechanism>" \
  --expect <validation-case-id> \
  --risk <held-out-case-id> \
  --validation <validation-eval.yaml> \
  --held-out <held-out-eval.yaml> \
  --promote
```

Without `--candidate`, the command creates an editable draft. `evolve verify` resumes that draft, `evolve inspect` returns its evidence and decision, and `evolve rollback` restores the exact pre-promotion overlay.

A minimal YAML adapter follows.

```yaml
site: example
name: search
description: Search example.com
transport: http
strategy: public
pipeline:
  - fetch: { url: "https://api.example.com/search?q=${{ args.query }}" }
  - select: data.results
  - map: { title: "${{ item.title }}", url: "${{ item.url }}" }
  - limit: "${{ args.limit }}"
args:
  - { name: query, type: string, required: true, positional: true }
  - { name: limit, type: int, default: 20 }
columns: [title, url]
```

Read the [adapter format](docs/ADAPTER-FORMAT.md), [pipeline reference](docs/reference/pipeline.md), and [self-repair guide](docs/guide/self-repair.md).

## Trust Boundaries

- Live browser cookies remain in process memory unless the user explicitly runs `auth import` or `browser cookies`.
- Browser automation uses Uni-CLI-owned profiles under `~/.unicli/`. Chrome 136+ does not support remote debugging on its default user-data directory.
- `unicli browser doctor --json` reports the available delivery path and exact repair command without starting a browser provider.
- Permission rules authorize before browser, file, clipboard, subprocess, or desktop side effects. Explicit malformed policies fail closed.
- Visual routes require a real configured backend. Missing providers return a structured error.
- Invocation diagnostics exclude arguments, content, URLs, credentials, and raw errors; users can disable new events with `UNICLI_NO_LOG=1`.

The detailed behavior and storage paths live in [Trust, Auth, and Limits](docs/guide/trust.md).

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run verify   # full E2E and adapter coverage; required before release
```

Requires Node.js 22.19 or newer. See [CONTRIBUTING.md](CONTRIBUTING.md) for adapter and engine conventions.

Browse every published version on the [generated release history](docs/releases.md). The same data is available to Agents through `docs/public/release-history.json`.

<p align="center"><sub>v1.1.1 — Artemis · Koch</sub></p>

## License

Apache-2.0
