<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
    <img src="assets/logo-light.svg" alt="Uni-CLI" width="360">
  </picture>
</p>

<h1 align="center">Uni-CLI</h1>

<p align="center">
  <strong>One CLI surface for agents to operate websites, desktop apps, local tools, and other CLIs.</strong>
</p>

<p align="center">
  Search by intent, run a real command, get a structured envelope back. If a site changes, the error points to the adapter file and step to repair.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@zenalexa/unicli"><img alt="npm" src="https://img.shields.io/npm/v/@zenalexa/unicli?style=flat-square"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
  <img alt="node >=20" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-2025--11--25-6f42c1?style=flat-square">
</p>

<p align="center">
  <sub><!-- STATS:site_count -->220<!-- /STATS --> sites · <!-- STATS:command_count -->1283<!-- /STATS --> commands · <!-- STATS:pipeline_step_count -->59<!-- /STATS --> pipeline steps · <!-- STATS:test_count -->7160<!-- /STATS --> tests</sub>
</p>

```bash
npm install -g @zenalexa/unicli
unicli search "hacker news frontpage"
unicli hackernews top -f json
```

<!-- IF YOU ARE AN AI AGENT: Start here.
Install: npm install -g @zenalexa/unicli
Discover: unicli search "your intent"
Run: unicli <site> <command> [args] [-f json|md|yaml|csv|compact]
Repair: read the error envelope, edit the adapter_path, run unicli repair <site> <command>
Prefer native CLI / JSON stream / MCP for agent runtimes. Use ACP as an editor compatibility gateway.
-->

## What It Does

Uni-CLI turns software surfaces into commands that agents can discover, run, and fix.

| Surface            | What you get                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Websites and APIs  | Declarative adapters for public, cookie, header, and browser-intercept workflows                   |
| Browser automation | CDP steps for navigate, click, type, intercept, snapshot, extract, wait, and related browser work  |
| Desktop and macOS  | System commands, app adapters, screenshots, clipboard, calendar, brightness, and local tools       |
| External CLIs      | 58 registered pass-through bridges with install/status discovery                                   |
| Agent backends     | Route matrix for native CLI, JSON stream, MCP, ACP, HTTP API, OpenAI-compatible, and bridge routes |
| Output             | v2 `AgentEnvelope` in Markdown, JSON, YAML, CSV, or compact format                                 |
| Repair             | Structured errors with `adapter_path`, failing `step`, retryability, suggestions, and alternatives |

## For Agents

Use search first, then run the smallest matching command.

```bash
unicli search "推特热门" --limit 5
unicli twitter search "coding agents" -f json
unicli repair twitter search
```

Output defaults to structured Markdown for non-TTY and agent-user-agent runs. Force a machine format when you need one:

```bash
UNICLI_OUTPUT=json unicli reddit hot --limit 10
unicli hackernews top --limit 5 -f yaml
```

Protocol entry points:

```bash
npx @zenalexa/unicli mcp serve
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
unicli acp
unicli agents recommend codex
unicli agents matrix
```

ACP is supported for editors and bridge tooling. The primary runtime path stays native CLI, JSON stream, or MCP when those routes are available.

## Coverage

The catalog is intentionally broad, but the important point is not the count. The important point is that every command is discoverable, typed, and repairable.

| Area                    | Examples                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Chinese platforms       | xiaohongshu, zhihu, bilibili, douyin, douban, v2ex, jike, linux-do                                          |
| International platforms | twitter, reddit, instagram, tiktok, discord, slack, hackernews, lesswrong                                   |
| AI and developer tools  | Claude, ChatGPT, Gemini, Codex, Cursor, VS Code, Docker Desktop, Postman                                    |
| Finance and news        | xueqiu, eastmoney, yahoo-finance, bloomberg, reuters, bbc, 36kr                                             |
| Desktop apps            | Blender, FreeCAD, GIMP, Audacity, Figma, Docker, ImageMagick, ffmpeg                                        |
| Agent CLIs              | Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code, Aider, Goose, Cursor Agent, Kiro, OpenHands, SWE-agent |

See the live catalog:

```bash
unicli list
unicli list --site macos
unicli ext list
unicli ext list --tag agent
```

## Output Contract

Every normal command returns a v2 envelope. `mcp serve` and `acp` are protocol servers and keep their raw stdio protocol.

```yaml
ok: true
schema_version: "2"
command: "twitter.search"
meta:
  duration_ms: 412
  count: 20
  surface: web
data:
  - { id: "...", text: "...", author: "..." }
error: null
```

Errors are meant to be acted on:

```yaml
ok: false
schema_version: "2"
command: "twitter.search"
meta:
  duration_ms: 91
data: null
error:
  code: auth_required
  message: "401 Unauthorized"
  adapter_path: "src/adapters/twitter/search.yaml"
  step: 1
  suggestion: "Run: unicli auth setup twitter"
  retryable: false
  alternatives: ["twitter.timeline", "twitter.profile"]
```

Exit codes: `0` ok, `66` empty, `69` unavailable, `75` temporary failure, `77` auth, `78` config.

## Self-Repair

Adapters are small YAML files by default. A failed command gives an agent enough context to patch the broken part without waiting for a package release.

```text
1. Run the command.
2. Read the error envelope.
3. Open error.adapter_path.
4. Patch the failing step.
5. Save the override in ~/.unicli/adapters/<site>/<command>.yaml.
6. Verify with unicli repair <site> <command>.
```

Local overrides survive npm updates.

## Write An Adapter

```yaml
site: example
name: search
description: "Search example.com"
transport: http
strategy: public
capabilities: [fetch, select, map, limit]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false
pipeline:
  - fetch:
      url: "https://api.example.com/search?q=${{ args.query }}"
  - select: data.results
  - map:
      title: "${{ item.title }}"
      url: "${{ item.url }}"
  - limit: "${{ args.limit }}"
args:
  - { name: query, type: string, required: true, positional: true }
  - { name: limit, type: int, default: 20 }
columns: [title, url]
```

Reference docs:

- [Quickstart](docs/QUICKSTART.md)
- [Adapter format](docs/ADAPTER-FORMAT.md)
- [Pipeline reference](docs/reference/pipeline.md)
- [Architecture](docs/ARCHITECTURE.md)
- [ACP / avante.nvim](docs/AVANTE.md)
- [Benchmarks](docs/BENCHMARK.md)

## Trust And Limits

- Auth-required sites use local cookie files under `~/.unicli/cookies/<site>.json`.
- Browser adapters require a reachable Chrome/CDP session.
- CUA routes require a configured real backend. Declared-but-unavailable providers fail closed with structured errors.
- User adapters and repairs live in `~/.unicli/adapters/`; committed adapters remain the package baseline.
- If a site blocks automation or changes a private API, the correct behavior is a clear failure envelope, not a fabricated success.

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
npm run verify
```

## License

[Apache-2.0](./LICENSE)

<p align="center">
  <sub>0.215.1</sub>
</p>
