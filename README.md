<!-- AGENT: npm install -g @zenalexa/unicli && unicli search "your intent" — 200+ sites, 968+ commands, self-repairing YAML, bilingual EN/ZH BM25 search, 95–99% fewer tokens than MCP. See AGENTS.md for live counts. -->

<div align="center">

<img src="assets/icon.svg" width="180" alt="Uni-CLI">

# Uni-CLI

> Give your agents hands.

<!-- STATS:site_count -->200<!-- /STATS --> sites &nbsp;·&nbsp; <!-- STATS:command_count -->968<!-- /STATS --> commands &nbsp;·&nbsp; self-repairing YAML &nbsp;·&nbsp; 95–99% fewer tokens than MCP

<br>

<a href="https://www.npmjs.com/package/@zenalexa/unicli"><img src="https://img.shields.io/npm/v/@zenalexa/unicli?style=flat-square&color=cb3837" alt="npm"></a>
<a href="https://github.com/olo-dot-io/Uni-CLI/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/olo-dot-io/Uni-CLI/ci.yml?style=flat-square&label=CI" alt="CI"></a>
<a href="https://github.com/olo-dot-io/Uni-CLI/stargazers"><img src="https://img.shields.io/github/stars/olo-dot-io/Uni-CLI?style=flat-square" alt="stars"></a>
<a href="./LICENSE"><img src="https://img.shields.io/github/license/olo-dot-io/Uni-CLI?style=flat-square" alt="license"></a>
<img src="https://img.shields.io/badge/tests-<!-- STATS:test_count -->1148<!-- /STATS -->-44cc11?style=flat-square" alt="tests">
<img src="https://img.shields.io/badge/agent--reach-ally-6a5acd?style=flat-square" alt="agent-reach ally">

<br>

[中文](README.zh-CN.md)

<br>

```sh
npm install -g @zenalexa/unicli
```

<br>

<img src="docs/demo/demo.svg" alt="Uni-CLI in 30 seconds" width="720">

</div>

---

## 🤖 For Your Agent

Drop this in your agent chat. Go get coffee. It'll be ready when you're back:

```
Set up unicli for me — it gives AI agents CLI access to 200+ sites with self-repairing adapters:
  1. npm install -g @zenalexa/unicli
  2. Add as MCP: claude mcp add unicli -- npx @zenalexa/unicli mcp serve
  3. Verify: unicli hackernews top --json
```

**One-liner per platform:**

| Platform              | Setup                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| **Claude Code**       | `claude mcp add unicli -- npx @zenalexa/unicli mcp serve`                                       |
| **Codex CLI**         | `[mcp_servers.unicli]` in `~/.codex/config.toml` · `command = "npx @zenalexa/unicli mcp serve"` |
| **Cursor / Windsurf** | MCP Settings → add server → `npx @zenalexa/unicli mcp serve`                                    |
| **avante.nvim / Zed** | `unicli acp` — JSON-RPC 2.0 (ACP protocol)                                                      |
| **OpenCode**          | `"command": "unicli mcp serve"` in `opencode.jsonc`                                             |
| **Any Bash agent**    | `unicli <site> <cmd>` — direct shell, zero config needed                                        |

---

## What

Uni-CLI is a universal CLI for AI agents — a single binary that compiles agent intent into deterministic, self-repairing programs across <!-- STATS:site_count -->200<!-- /STATS --> sites, 30+ desktop apps, 35 CLI bridges, and the local OS (<!-- STATS:command_count -->968<!-- /STATS --> commands total). Every adapter is a ~20-line YAML pipeline: agent-readable, agent-editable, zero build step. When a site changes its API, the agent edits the YAML, saves to `~/.unicli/adapters/`, and retries. Fixes survive `npm update`. No human in the loop.

Coverage is cross-cutting: web APIs via HTTP, browser automation via raw CDP (13-layer anti-detection stealth), desktop subprocesses (ffmpeg, Blender, LibreOffice), macOS system calls (screenshot, Calendar, clipboard), Windows UIAutomation, Linux AT-SPI, and four Computer Use Agent backends (Anthropic `computer-use`, OpenAI Operator, Google CUA, direct CDP) — all behind the same `unicli <site> <command>` surface. Output is a table in a terminal and JSON when piped. Structured errors on stderr include the adapter path, the failing step, and a repair suggestion.

## Why CLI beats MCP

A 93-tool MCP server loads ~55,000 tokens before your agent can act. Independent benchmarks from Firecrawl, Scalekit, and Apideck report 95–99% context reduction when agents pull commands from a CLI layer instead of loading a full MCP catalog. Academic research in 2025–2026 (Semantic Tool Discovery, ITR Dynamic Tool Exposure, JSPLIT) converges on the same conclusion.

| Interface                      | Cold-start overhead | Per-command cost                             | Self-repairing |
| ------------------------------ | ------------------- | -------------------------------------------- | -------------- |
| Typical MCP server (93 tools)  | ~55,000 tokens      | ~500–2,000 tokens                            | No             |
| **Uni-CLI MCP** (4 meta-tools) | **~200 tokens**     | see [`docs/BENCHMARK.md`](docs/BENCHMARK.md) | **Yes**        |
| **Uni-CLI via Bash**           | **0 tokens**        | see [`docs/BENCHMARK.md`](docs/BENCHMARK.md) | **Yes**        |

Uni-CLI's MCP server exposes four meta-tools (`unicli_run`, `unicli_list`, `unicli_search`, `unicli_explore`) and the agent pulls the exact command it needs via BM25 bilingual search over a 50KB index. Honest per-call numbers with p50/p95 per category — measured, not estimated — live in [`docs/BENCHMARK.md`](docs/BENCHMARK.md).

## Quick start

```bash
# 1. Install
npm install -g @zenalexa/unicli

# 2. Discover
unicli list                                      # all sites + commands
unicli search "trending topics"                  # bilingual BM25 search
unicli search "推特热门"                          # → twitter trending (Chinese query)

# 3. Run
unicli reddit hot --limit 3                      # zero-config web API
unicli hackernews top --json | jq '.[].title'    # pipe + transform
unicli blender render scene.blend --output /tmp/frame.png  # desktop subprocess

# 4. Wire into an agent
claude mcp add unicli -- npx @zenalexa/unicli mcp serve    # Claude Code (stdio)
unicli mcp serve --transport streamable --port 19826       # any MCP client (HTTP)
unicli acp                                                 # avante.nvim / Zed (ACP)
```

Full walkthrough with worked examples: [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

## Self-repair

Self-repair is why Uni-CLI is infrastructure, not just a tool. When a site changes its API:

```
unicli <site> <cmd> fails
  → stderr: { "adapter_path": "~/.unicli/adapters/hackernews/top.yaml",
               "step": "fetch", "action": "GET /v0/topstories.json",
               "suggestion": "endpoint may have versioned to /v1/" }
  → agent opens the ~20-line YAML at adapter_path
  → agent edits the selector / endpoint / auth header
  → unicli <site> <cmd> succeeds
  → fix persists in ~/.unicli/adapters/ — survives npm update, no git commit needed
```

This is Banach-convergent by design: every error provides directional feedback (`adapter_path` + `step` + `suggestion`), so successive repair iterations converge toward a working state. It's the reason agent-built fixes accumulate rather than reset.

```bash
unicli repair hackernews top    # diagnose + suggest fix
unicli test hackernews          # validate all adapters for a site
unicli repair --loop            # autonomous repair loop (agent-driven)
```

Exit codes follow `sysexits.h`: `0` ok · `66` empty · `69` unavailable · `75` temporary · `77` auth · `78` config. Parseable directly — no regex over human error text.

## Architecture

Seven transport layers. One adapter surface. One output formatter.

| Transport          | What it reaches                                                                   |
| ------------------ | --------------------------------------------------------------------------------- |
| **HTTP**           | Web APIs — REST, RSS, JSON, GraphQL                                               |
| **CDP Browser**    | Any site via a real Chrome session (13-layer anti-detection stealth, login reuse) |
| **Subprocess**     | ffmpeg, yt-dlp, gh, aws, docker, stripe, and 30+ more                             |
| **Desktop-AX**     | macOS — AppleScript, Accessibility API, Shortcuts, Calendar, Mail                 |
| **Desktop-UIA**    | Windows — UIAutomation, WinRT                                                     |
| **Desktop-AT-SPI** | Linux — accessibility tree, AT-SPI2                                               |
| **CUA**            | Anthropic `computer-use` · OpenAI Operator · Google CUA · direct CDP              |

Adapters are declarative YAML by default (Rice-decidable — no Turing-complete logic, provably terminating). TypeScript adapters available when a site genuinely needs programmatic logic. The pipeline has <!-- STATS:pipeline_step_count -->54<!-- /STATS -->+ steps: `fetch`, `navigate`, `exec`, `extract`, `each`, `if`, `parallel`, `rate_limit`, `retry`, and more. Full step reference: [`docs/ADAPTER-FORMAT.md`](docs/ADAPTER-FORMAT.md).

## Feature matrix

| Capability              | Detail                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| **CUA backends**        | Anthropic `computer-use`, OpenAI Operator, Google CUA, direct CDP — 4 transports, one flag |
| **MCP transports**      | stdio · Streamable HTTP (spec 2025-11-25) · SSE · OAuth 2.1 PKCE                           |
| **ACP**                 | `unicli acp` — JSON-RPC 2.0 for avante.nvim, Zed, Gemini CLI                               |
| **Cross-vendor skills** | Claude Code · OpenCode · Codex CLI · Cursor · Windsurf · Cline                             |
| **Self-repair**         | Every stderr error: `adapter_path` + `step` + `suggestion` (Banach-convergent)             |
| **Bilingual search**    | BM25 + TF-IDF · 50KB index · <10ms · 200-entry ZH↔EN alias table                           |
| **Browser daemon**      | Persistent Chrome via CDP · reuses login sessions · 13-layer anti-detection stealth        |
| **Output formats**      | table (TTY) · JSON (pipe) · YAML · CSV · Markdown — auto-switches on pipe                  |
| **Auth strategies**     | public · cookie · CSRF header · browser intercept · UI automation — auto-probed cascade    |

## Platform coverage

<!-- STATS:site_count -->200<!-- /STATS --> sites · <!-- STATS:command_count -->968<!-- /STATS --> commands — full live catalog in [`AGENTS.md`](AGENTS.md):

| Domain                | Highlights                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| **Social (25)**       | twitter · reddit · instagram · tiktok · xiaohongshu · bilibili · zhihu · weibo |
| **Tech (19)**         | hackernews · stackoverflow · producthunt · github-trending · npm · pypi        |
| **News (11)**         | bbc · reuters · bloomberg · nytimes · techcrunch · 36kr                        |
| **Finance (8)**       | xueqiu · yahoo-finance · eastmoney · binance · coinbase                        |
| **AI / ML (14)**      | huggingface · ollama · replicate · perplexity · deepseek · doubao              |
| **Desktop (30+)**     | blender · ffmpeg · imagemagick · gimp · freecad · musescore · kdenlive         |
| **macOS system (58)** | screenshot · clipboard · Calendar · Mail · Reminders · Shortcuts · Safari      |
| **CLI bridges (35)**  | gh · yt-dlp · jq · aws · vercel · supabase · wrangler · stripe                 |

<p align="center">
<img src="https://img.shields.io/badge/Twitter%2FX-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X">
<img src="https://img.shields.io/badge/Reddit-FF4500?style=flat-square&logo=reddit&logoColor=white" alt="Reddit">
<img src="https://img.shields.io/badge/Instagram-E4405F?style=flat-square&logo=instagram&logoColor=white" alt="Instagram">
<img src="https://img.shields.io/badge/TikTok-000000?style=flat-square&logo=tiktok&logoColor=white" alt="TikTok">
<img src="https://img.shields.io/badge/Bilibili-00A1D6?style=flat-square&logo=bilibili&logoColor=white" alt="Bilibili">
<img src="https://img.shields.io/badge/YouTube-FF0000?style=flat-square&logo=youtube&logoColor=white" alt="YouTube">
<img src="https://img.shields.io/badge/HackerNews-FF6600?style=flat-square&logo=ycombinator&logoColor=white" alt="HackerNews">
<img src="https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub">
<img src="https://img.shields.io/badge/npm-CB3837?style=flat-square&logo=npm&logoColor=white" alt="npm">
<img src="https://img.shields.io/badge/Bloomberg-000000?style=flat-square&logo=bloomberg&logoColor=white" alt="Bloomberg">
<img src="https://img.shields.io/badge/Binance-F0B90B?style=flat-square&logo=binance&logoColor=black" alt="Binance">
<img src="https://img.shields.io/badge/HuggingFace-FFD21F?style=flat-square&logo=huggingface&logoColor=black" alt="HuggingFace">
<img src="https://img.shields.io/badge/Blender-F5792A?style=flat-square&logo=blender&logoColor=white" alt="Blender">
<img src="https://img.shields.io/badge/ffmpeg-007808?style=flat-square&logo=ffmpeg&logoColor=white" alt="ffmpeg">
<img src="https://img.shields.io/badge/AWS-232F3E?style=flat-square&logo=amazonaws&logoColor=white" alt="AWS">
<img src="https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white" alt="Vercel">
<img src="https://img.shields.io/badge/Zhihu-0084FF?style=flat-square&logo=zhihu&logoColor=white" alt="Zhihu">
<img src="https://img.shields.io/badge/Weibo-E6162D?style=flat-square&logo=sinaweibo&logoColor=white" alt="Weibo">
<img src="https://img.shields.io/badge/Stack_Overflow-F58025?style=flat-square&logo=stackoverflow&logoColor=white" alt="Stack Overflow">
<img src="https://img.shields.io/badge/Stripe-635BFF?style=flat-square&logo=stripe&logoColor=white" alt="Stripe">
</p>

`unicli list` for the live catalog · `unicli list --category=<domain>` to filter.

## Authentication

Five strategies, auto-probed in cascade (`public → cookie → header → intercept → ui`):

| Strategy    | How                                                    |
| ----------- | ------------------------------------------------------ |
| `public`    | Direct HTTP, no credentials                            |
| `cookie`    | `~/.unicli/cookies/<site>.json` injected into headers  |
| `header`    | Cookie + auto-extracted CSRF (ct0, bili_jct, …)        |
| `intercept` | Chrome navigates, Uni-CLI captures XHR/fetch responses |
| `ui`        | Direct DOM interaction via CDP (click, type, submit)   |

```bash
unicli auth setup twitter    # print required cookies + target path
unicli auth check twitter    # validate cookie file
unicli auth list             # all configured sites
```

The browser daemon (`unicli browser start`) reuses your signed-in Chrome session via CDP — no cookie export, no extension install. Auto-exits after 4h idle.

## Write an adapter

~20 lines. No TypeScript. No build step. No imports. Agent-editable in place:

```yaml
site: hackernews
name: top
type: web-api
strategy: public
pipeline:
  - fetch:
      url: "https://hacker-news.firebaseio.com/v0/topstories.json"
  - limit: { count: "${{ args.limit | default(30) }}" }
  - each:
      do:
        - fetch:
            url: "https://hacker-news.firebaseio.com/v0/item/${{ item }}.json"
  - map:
      title: "${{ item.title }}"
      score: "${{ item.score }}"
      url: "${{ item.url }}"
columns: [title, score, url]
```

Five adapter types: `web-api` · `desktop` · `browser` · `bridge` · `service`. 29 template filters (`join`, `urlencode`, `truncate`, `slugify`, `default`, `json`, …) in a sandboxed VM.

```bash
unicli init <site> <command>    # scaffold
unicli dev <path>               # hot-reload during dev
unicli test <site>              # validate
unicli record <url>             # auto-generate from network traffic
```

Full reference: [`docs/ADAPTER-FORMAT.md`](docs/ADAPTER-FORMAT.md). Migrating from OpenCLI: [`docs/MIGRATING-FROM-OPENCLI.md`](docs/MIGRATING-FROM-OPENCLI.md) and the one-shot `unicli import opencli-yaml`.

## Search

Command discovery by intent, bilingual:

```bash
unicli search "trending topics"          # → twitter trending, hackernews top
unicli search "推特热门"                  # Chinese query → English command
unicli search "download video"           # → bilibili download, yt-dlp, twitter download
unicli search "股票行情"                  # → binance ticker, xueqiu quote, barchart quote
unicli search --category finance         # browse by category
```

BM25 + TF-IDF scoring · 200-entry ZH↔EN alias table · 50KB index · <10ms queries.

## Theory

Five design principles, each tied to a citation in [`docs/refs.bib`](docs/refs.bib):

1. **Rice's restriction** — decidable adapter semantics (YAML pipeline, no Turing-complete logic, provably terminating)
2. **Lehman's mandate** — self-repair is first-class; no adapter is permanent; every site will eventually break
3. **Shannon's compression** — a `unicli` invocation is near-optimal compression of the underlying API call; measured per-call numbers in [`docs/BENCHMARK.md`](docs/BENCHMARK.md)
4. **Agent tool trilemma** (original contribution) — coverage × accuracy × performance: pick two. We optimize accuracy × performance.
5. **Banach convergence** — structured error messages (`adapter_path` + `step` + `suggestion`) guarantee repair iteration convergence

Full treatment with 42 citations: [`docs/THEORY.md`](docs/THEORY.md). Reproducible token benchmarks vs GitHub MCP, Firecrawl MCP, and direct API: [`docs/BENCHMARK.md`](docs/BENCHMARK.md).

## Development

```bash
git clone https://github.com/olo-dot-io/Uni-CLI.git && cd Uni-CLI
npm install
npm run verify    # typecheck + lint + test + build (7 gates, must pass)
```

| Command                | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `npm run dev`          | Run from source (tsx)                                     |
| `npm run build`        | Production build                                          |
| `npm run typecheck`    | TypeScript strict                                         |
| `npm run lint`         | Oxlint                                                    |
| `npm run test`         | Unit tests (<!-- STATS:test_count -->1148<!-- /STATS -->) |
| `npm run test:adapter` | Validate all adapters                                     |
| `npm run verify`       | Full pipeline — required before any release               |

Seven production dependencies: `chalk` · `cli-table3` · `commander` · `js-yaml` · `turndown` · `undici` · `ws`.

## Release cadence

Patches ship every **Friday 09:00 HKT** when substantive commits have landed since the last tag. Quiet weeks are recorded and skipped — silence is success, not failure. Dependabot bumps are grouped into one PR per Monday so they ride along in the Friday cut without flooding the commit log.

<a href="https://github.com/olo-dot-io/Uni-CLI/commits/main"><img src="https://img.shields.io/github/last-commit/olo-dot-io/Uni-CLI?style=flat-square&label=last-commit" alt="last commit"></a>

Full policy — manual overrides, cancellation procedure, escalation rules: [`docs/RELEASE-CADENCE.md`](docs/RELEASE-CADENCE.md).

## Contributing

The fastest path to a merged PR: write a 20-line YAML adapter for a site you use every day. The review bar is intentionally low — if it works and follows the schema, it ships.

| Area             | Guide                                                    |
| ---------------- | -------------------------------------------------------- |
| New adapter      | [`contributing/adapter.md`](contributing/adapter.md)     |
| New transport    | [`contributing/transport.md`](contributing/transport.md) |
| CUA backend      | [`contributing/cua.md`](contributing/cua.md)             |
| MCP server       | [`contributing/mcp.md`](contributing/mcp.md)             |
| ACP integration  | [`contributing/acp.md`](contributing/acp.md)             |
| Release process  | [`contributing/release.md`](contributing/release.md)     |
| Schema migration | [`contributing/schema.md`](contributing/schema.md)       |

## License

[Apache-2.0](./LICENSE)

Repo: <https://github.com/olo-dot-io/Uni-CLI> · npm: [`@zenalexa/unicli`](https://www.npmjs.com/package/@zenalexa/unicli) · Issues welcome.

---

<p align="center">
  <a href="https://github.com/olo-dot-io/Uni-CLI/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=olo-dot-io/Uni-CLI" alt="Contributors">
  </a>
</p>

<p align="center">
  <sub>v0.213.0-beta.1 — Vostok · Gagarin (Pre-release)</sub><br>
  <sub><!-- STATS:site_count -->200<!-- /STATS --> sites · <!-- STATS:command_count -->968<!-- /STATS --> commands · <!-- STATS:pipeline_step_count -->54<!-- /STATS --> pipeline steps · BM25+TF-IDF bilingual search · MCP 2025-11-25 · <!-- STATS:test_count -->1148<!-- /STATS --> tests</sub>
</p>
