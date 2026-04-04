<h1 align="center">Uni-CLI</h1>

<p align="center">
  <strong>CLI IS ALL AGENTS NEED</strong><br>
  The entry point for AI agents to touch, sense, understand, modify, and control<br>
  any internet application and local software — through CLI.<br>
  20-line YAML · Self-repairing · Agent-native
</p>

<p align="center">
  <a href="#-quick-start"><img src="https://img.shields.io/badge/Quick_Start-3_min-blue?style=for-the-badge" alt="Quick Start"></a>
  <a href="#-self-repair"><img src="https://img.shields.io/badge/Self--Repair-Agent_Fixes_Itself-ff69b4?style=for-the-badge" alt="Self-Repair"></a>
  <a href="#-for-ai-agents"><img src="https://img.shields.io/badge/21_Sites-74_Commands-green?style=for-the-badge" alt="Coverage"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/unicli"><img src="https://img.shields.io/npm/v/unicli?style=flat-square" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/unicli?style=flat-square" alt="Node.js"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/unicli?style=flat-square" alt="License"></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/docs-中文-0F766E?style=flat-square" alt="中文文档"></a>
</p>

---

**CLI is the universal interface for AI agents.** ~80 tokens per invocation. Composable via Unix pipes. Deterministic. And with Uni-CLI, **self-repairing** — when an adapter breaks, the agent reads the 20-line YAML, fixes it, and moves on. No human needed.

**For AI Agents** — Structured JSON output, machine-readable exit codes, self-repair protocol. Agents can diagnose, fix, and verify their own tools.

**For Humans** — Beautiful table output, multiple formats, `unicli doctor` for diagnostics.

---

## 🔧 Self-Repair — Why Uni-CLI Exists

This is not a feature. This is the reason the project exists.

```
unicli <site> <command>
  → Fails (API changed, endpoint moved)
  → Structured error JSON:
    { "adapter": "src/adapters/twitter/search.yaml",
      "step": 0, "action": "fetch", "statusCode": 403,
      "suggestion": "API requires cookie auth." }
  → Agent reads 20-line YAML (fits any context window)
  → Agent edits YAML → saves to ~/.unicli/adapters/
  → Agent retries → fixed. Fix persists across updates.
```

| Requirement                      | Other tools              | Uni-CLI                            |
| -------------------------------- | ------------------------ | ---------------------------------- |
| Structured errors with file path | ❌ Human strings         | ✅ JSON + adapter path             |
| Agent can read the adapter       | ❌ 50-300 line TS/Python | ✅ 20-line YAML                    |
| Fix survives updates             | ❌ Overwritten           | ✅ ~/.unicli/adapters/ overlay     |
| Agent can verify the fix         | ❌ No test command       | ✅ `unicli repair` + `unicli test` |

---

## Why CLI, Not MCP?

MCP sounds great in theory. In practice (April 2026): 3 MCP servers eat **72% of a 200K context window** before you type anything. Each tool definition costs 550-1,400 tokens. A CLI call costs ~80 tokens.

CLI through Bash is: universal (every agent has it), composable (pipes), self-repairable (agent edits YAML), and context-efficient (2 orders of magnitude cheaper than MCP).

---

## 🌍 Coverage

Uni-CLI turns **any interface** — websites, desktop apps, cloud APIs, local services, existing CLI tools — into structured, scriptable commands:

```
┌─────────────────────────────────────────────────────┐
│                   Uni-CLI                            │
│                                                     │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐  │
│  │ web-api │ │ desktop │ │ browser  │ │ bridge  │  │
│  │         │ │         │ │          │ │         │  │
│  │ Twitter │ │ Blender │ │ 小红书   │ │ gh      │  │
│  │ Reddit  │ │ GIMP    │ │ Taobao   │ │ docker  │  │
│  │ Bilibili│ │ FreeCAD │ │ WeChat   │ │ kubectl │  │
│  │ HN      │ │ OBS     │ │ LinkedIn │ │ vercel  │  │
│  └─────────┘ └─────────┘ └──────────┘ └─────────┘  │
│                                                     │
│  ┌─────────────────────────────────────────────────┐│
│  │ service: Ollama · ComfyUI · WireMock · Zoom     ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

| Feature            | Uni-CLI               | OpenCLI           | CLI-Anything        |
| ------------------ | --------------------- | ----------------- | ------------------- |
| Websites → CLI     | ✅                    | ✅                | ❌                  |
| Desktop apps → CLI | ✅                    | Partial           | ✅                  |
| Browser automation | ✅                    | ✅                | ❌                  |
| Local services     | ✅                    | ❌                | ✅                  |
| Agent self-repair  | ✅ Full loop          | ❌                | ❌                  |
| Structured errors  | ✅ JSON               | ❌ Strings        | ❌ Traceback        |
| Adapter format     | 20-line YAML          | 50-300 line TS    | 500-900 line Python |
| Fix persists       | ✅ ~/.unicli/ overlay | ❌ npm overwrites | ❌ pip overwrites   |
| Repair command     | ✅ `unicli repair`    | ❌                | ❌                  |
| Test command       | ✅ `unicli test`      | ❌                | ❌                  |

---

## 🚀 Quick Start

### Install

```bash
npm install -g unicli
```

### Try It

```bash
unicli doctor                         # Check system health
unicli list                           # See all commands
unicli hackernews top --limit 5       # Hacker News top stories
unicli hackernews search "AI agents"  # Search HN
```

### Output Formats

```bash
unicli hackernews top                 # Human-readable table
unicli hackernews top -f json         # Structured JSON (for AI agents)
unicli hackernews top -f csv          # Spreadsheet-friendly
unicli hackernews top -f yaml         # Config-friendly
unicli hackernews top -f md           # Markdown table
```

When piped (non-TTY), output **automatically** switches to JSON:

```bash
unicli hackernews top | jq '.[0].title'   # Agent-friendly by default
```

---

## 🧩 Adapter Types

Uni-CLI supports **five adapter types** — covering every kind of software:

### Type 1: `web-api` — REST APIs

```yaml
# src/adapters/hackernews/top.yaml
site: hackernews
type: web-api
strategy: public

pipeline:
  - fetch:
      url: https://hacker-news.firebaseio.com/v0/topstories.json
  - map:
      title: ${{ item.title }}
      score: ${{ item.score }}
columns: [title, score]
```

### Type 2: `desktop` — Local Desktop Software

```yaml
# src/adapters/blender/render.yaml
site: blender
type: desktop
binary: blender
detect: which blender

args:
  file: { type: str, required: true, positional: true }
  output: { type: str, default: ./output.png }

execArgs:
  - --background
  - ${{ args.file }}
  - --render-output
  - ${{ args.output }}
  - --render-frame
  - "1"
```

```bash
unicli blender render scene.blend --output ./render.png
```

### Type 3: `browser` — Full Browser Automation

```yaml
# src/adapters/xiaohongshu/feed.yaml
site: xiaohongshu
type: browser
strategy: cookie
requires: login

navigate: https://www.xiaohongshu.com/explore
wait: .note-item
extract: .note-item[].{title, likes, author}
```

### Type 4: `bridge` — Existing CLI Passthrough

```yaml
# src/adapters/gh/bridge.yaml
site: gh
type: bridge
binary: gh
autoInstall: brew install gh
passthrough: true
```

```bash
unicli gh pr list --limit 5    # Passes through to `gh pr list --limit 5`
```

### Type 5: `service` — Local/Remote HTTP Services

```yaml
# src/adapters/ollama/list.yaml
site: ollama
type: service
base: http://localhost:11434
health: /api/tags

pipeline:
  - fetch:
      url: ${{ base }}/api/tags
  - select: models
  - map:
      name: ${{ item.name }}
      size: ${{ item.size }}
columns: [name, size]
```

---

## 🤖 For AI Agents

Uni-CLI is designed agent-first. Three integration paths:

### MCP Server (Universal)

Works with Claude Code, Cursor, Windsurf, Codex, OpenCode — any MCP-compatible agent:

```json
{
  "mcpServers": {
    "unicli": {
      "command": "unicli",
      "args": ["mcp"]
    }
  }
}
```

### Agent Skills

```bash
npx skills add ZenAlexa/Uni-CLI                         # All skills
npx skills add ZenAlexa/Uni-CLI --skill unicli-usage     # Usage guide
npx skills add ZenAlexa/Uni-CLI --skill unicli-operate   # Browser automation
npx skills add ZenAlexa/Uni-CLI --skill unicli-explorer  # Adapter development
```

### AGENTS.md / CLAUDE.md

Add to your project's `AGENTS.md` or `CLAUDE.md`:

```markdown
## CLI Tools

- `unicli <site> <command>` — Universal CLI for websites, desktop apps, and services
- `unicli list` — Discover all available commands
```

---

## 📦 Built-in Adapters

| Site                | Type    | Commands       | Auth                  |
| ------------------- | ------- | -------------- | --------------------- |
| **hackernews**      | web-api | `top` `search` | No                    |
| **reddit**          | web-api | `hot` `search` | No                    |
| **github-trending** | web-api | `daily`        | No                    |
| **blender**         | desktop | `render`       | No (requires blender) |
| **ffmpeg**          | desktop | `convert`      | No (requires ffmpeg)  |
| **ollama**          | service | `list`         | No (requires ollama)  |

> 6 sites, 8 commands across 3 adapter types. [Contribute yours →](./CONTRIBUTING.md)

---

## 🔌 Plugins

Extend Uni-CLI with community adapters:

```bash
unicli plugin install github:user/unicli-plugin-example
unicli plugin list
unicli plugin update --all
```

---

## 🏗️ Architecture

```
src/
├── main.ts              # Entry point
├── cli.ts               # Commander routing
├── types.ts             # 5 adapter types, Strategy enum, IPage, ExitCode
├── registry.ts          # Adapter registry + cli() helper
├── engine/              # Execution engines (YAML pipeline, subprocess, browser, HTTP)
├── output/formatter.ts  # table/json/yaml/csv/md + agent auto-detection
├── discovery/loader.ts  # Scans adapters/ for YAML + TS files
├── adapters/            # Built-in adapters
├── browser/             # Chrome Extension CDP bridge
├── hub/                 # External CLI hub + auto-install
├── plugin/              # Plugin system
└── mcp/                 # MCP stdio server for AI agents
```

### Adapter Resolution

```
unicli <site> <command> [options]
         │         │
         ▼         ▼
    ┌──────────────────┐
    │  Adapter Registry │
    │  (YAML + TS scan) │
    └────────┬─────────┘
             │
    ┌────────▼─────────┐
    │  Execution Engine │
    │  ┌─────┐ ┌─────┐ │
    │  │ HTTP│ │ CDP │ │
    │  ├─────┤ ├─────┤ │
    │  │ exec│ │ hub │ │
    │  └─────┘ └─────┘ │
    └────────┬─────────┘
             │
    ┌────────▼─────────┐
    │ Output Formatter  │
    │ table│json│csv│md │
    └──────────────────┘
```

---

## Exit Codes

Following Unix `sysexits.h` conventions:

| Code | Meaning             | When                  |
| ---- | ------------------- | --------------------- |
| `0`  | Success             | Command completed     |
| `1`  | Generic error       | Unexpected failure    |
| `2`  | Usage error         | Bad arguments         |
| `66` | Empty result        | No data returned      |
| `69` | Service unavailable | Browser not connected |
| `75` | Temporary failure   | Timeout — retry       |
| `77` | Auth required       | Not logged in         |
| `78` | Config error        | Missing credentials   |

---

## Development

```bash
git clone https://github.com/ZenAlexa/Uni-CLI.git && cd Uni-CLI
npm install
npm run dev -- list                   # Test adapter loading
npm run dev -- hackernews top         # Test a command
npm run verify                        # Full check: format + tsc + lint + test + build
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The fastest contribution: add a 20-line YAML adapter for a site you use.

## Star History

<a href="https://star-history.com/#ZenAlexa/Uni-CLI&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ZenAlexa/Uni-CLI&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ZenAlexa/Uni-CLI&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ZenAlexa/Uni-CLI&type=Date" />
  </picture>
</a>

## Acknowledgments

Uni-CLI stands on the shoulders of those who pioneered CLI-for-agents:

- **[OpenCLI](https://github.com/jackwener/opencli)** by [@jackwener](https://github.com/jackwener) — Proved that any website can become a CLI command. The YAML adapter format, browser bridge architecture, and `explore`/`synthesize` workflow are foundational to this ecosystem. Uni-CLI's web adapter format is directly inspired by OpenCLI's elegant pipeline design.

- **[CLI-Anything](https://github.com/HKUDS/CLI-Anything)** by [HKUDS](https://github.com/HKUDS) (Prof. Chao Huang's lab at HKU) — Showed that desktop software can be made agent-native. The vision of wrapping Blender, GIMP, FreeCAD, and even games into CLI harnesses expanded what "CLI" means. Uni-CLI's desktop adapter type exists because CLI-Anything proved it was possible.

- **[Vercel agent-browser](https://github.com/vercel-labs/agent-browser)** — Demonstrated that accessibility-tree-first browser automation can be 16x more token-efficient than full-page approaches.

- The broader open-source AI agent ecosystem: [Claude Code](https://github.com/anthropics/claude-code), [Codex CLI](https://github.com/openai/codex), [OpenCode](https://github.com/opencode-ai/opencode), [Stagehand](https://github.com/browserbase/stagehand), [Browser Use](https://github.com/browser-use/browser-use), and the [MCP](https://modelcontextprotocol.io/) standard — for building the world where tools like Uni-CLI are needed.

## License

[Apache-2.0](./LICENSE)

---

<p align="center">
  <sub>Codename <strong>Sputnik</strong> — First signal from orbit.</sub><br>
  <sub>Built with care for AI agents and the humans who guide them.</sub>
</p>
