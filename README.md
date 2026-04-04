<h1 align="center">Uni-CLI</h1>

<p align="center">
  <strong>CLI IS ALL YOU NEED</strong><br>
  Turn any website, desktop app, cloud service, or system tool into a CLI command.<br>
  20-line YAML adapters · Zero LLM cost · Agent-native
</p>

<p align="center">
  <a href="#-quick-start"><img src="https://img.shields.io/badge/Quick_Start-3_min-blue?style=for-the-badge" alt="Quick Start"></a>
  <a href="#-adapter-types"><img src="https://img.shields.io/badge/5_Adapter_Types-Universal-ff69b4?style=for-the-badge" alt="Adapter Types"></a>
  <a href="#-for-ai-agents"><img src="https://img.shields.io/badge/Agent_Native-MCP_%2B_Skills-green?style=for-the-badge" alt="Agent Native"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/unicli"><img src="https://img.shields.io/npm/v/unicli?style=flat-square" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/unicli?style=flat-square" alt="Node.js"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/unicli?style=flat-square" alt="License"></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/docs-中文-0F766E?style=flat-square" alt="中文文档"></a>
</p>

---

A single CLI that turns **any interface** — websites, desktop apps, cloud APIs, local services, existing CLI tools — into structured, scriptable commands. Designed from the ground up for AI agents.

**For AI Agents** — Built-in MCP server, Agent Skills, and auto-detection of piped output. Claude Code, Codex, Cursor, OpenCode — Uni-CLI works with all of them.

**For Humans** — Beautiful table output, multiple formats, shell completion, and `unicli doctor` for self-diagnostics.

---

## Why Uni-CLI?

The AI agent ecosystem has fragmented CLI tools: one for websites, another for desktop apps, yet another for browser automation. **Uni-CLI unifies them all** with a single adapter format:

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

| Feature | Uni-CLI | OpenCLI | CLI-Anything |
|---------|--------|---------|--------------|
| Websites → CLI | ✅ | ✅ | ❌ |
| Desktop apps → CLI | ✅ | Partial | ✅ |
| Browser automation | ✅ | ✅ | ❌ |
| System CLI hub | ✅ | ✅ | ❌ |
| Local services | ✅ | ❌ | ✅ |
| YAML adapters | ✅ 20 lines | ✅ | ❌ (Python pkg) |
| MCP server | ✅ Built-in | ❌ | ❌ |
| Agent Skills | ✅ | ✅ | ✅ |
| Unified format | ✅ | ❌ (2 formats) | ❌ (Python) |

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

| Site | Type | Commands | Auth |
|------|------|----------|------|
| **hackernews** | web-api | `top` `search` | No |
| **reddit** | web-api | `hot` `search` | No |
| **github-trending** | web-api | `daily` | No |
| **blender** | desktop | `render` | No (requires blender) |
| **ffmpeg** | desktop | `convert` | No (requires ffmpeg) |
| **ollama** | service | `list` | No (requires ollama) |

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

| Code | Meaning | When |
|------|---------|------|
| `0` | Success | Command completed |
| `1` | Generic error | Unexpected failure |
| `2` | Usage error | Bad arguments |
| `66` | Empty result | No data returned |
| `69` | Service unavailable | Browser not connected |
| `75` | Temporary failure | Timeout — retry |
| `77` | Auth required | Not logged in |
| `78` | Config error | Missing credentials |

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
