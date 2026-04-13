# Agent Platform Integration

> One-page guide to integrate Uni-CLI with your agent platform.

## Prerequisites

```bash
npm install -g @zenalexa/unicli
```

Verify installation:

```bash
unicli list          # 200 sites, 969 commands
unicli mcp health    # MCP server health check
```

---

## Claude Code

### Option A: MCP Server (recommended)

```bash
claude mcp add unicli -- npx @zenalexa/unicli mcp serve
```

### Option B: Direct CLI

Add to `CLAUDE.md` or `AGENTS.md`:

```markdown
## Uni-CLI

`unicli <site> <command>` — 200 sites, 969 commands, piped output auto-switches to JSON.

Examples:
unicli hackernews top
unicli github trending --language typescript
unicli twitter search "AI agents"
```

### Option C: Slash Commands

```bash
cp -r skills/unicli-claude/commands/ .claude/commands/
```

---

## Codex CLI

### MCP Server

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.unicli]
command = ["npx", "-y", "@zenalexa/unicli", "mcp", "serve"]
enabled = true
```

### AGENTS.md

Already included in repo root — Codex discovers it automatically.

### Auto-Approve Rules

```bash
cp packages/codex-rules/unicli.star ~/.codex/rules/
```

This approves all `unicli`, `npx @zenalexa/unicli`, and `npx unicli` commands without confirmation prompts.

### Skill

```bash
cp -r skills/unicli/ .agents/skills/unicli/
```

---

## OpenClaw

### Plugin (recommended)

```bash
openclaw plugins install @zenalexa/openclaw-unicli
```

### MCP Server

Add to `~/.openclaw/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "unicli": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@zenalexa/unicli", "mcp", "serve"]
      }
    }
  }
}
```

---

## Hermes Agent

### MCP Server

Add to `config.yaml`:

```yaml
mcp_servers:
  unicli:
    command: "npx"
    args: ["-y", "@zenalexa/unicli", "mcp", "serve"]
```

### Skill

Install from Skills Hub or copy manually:

```bash
cp -r skills/unicli-hermes/ .agents/skills/unicli/
```

---

## OpenCode

### MCP Server

Add to `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "unicli": {
      "type": "local",
      "command": ["npx", "-y", "@zenalexa/unicli", "mcp", "serve"],
      "enabled": true,
    },
  },
}
```

---

## Auto-Generate Platform Config

```bash
unicli agents generate --for claude     # Claude Code config
unicli agents generate --for codex      # Codex CLI config
unicli agents generate --for openclaw   # OpenClaw config
unicli agents generate --for hermes     # Hermes config
unicli agents generate --for opencode   # OpenCode config
```

---

## Verification

```bash
unicli mcp health       # Check MCP server health
unicli list             # Verify 200 sites, 969 commands loaded
unicli test hackernews  # Quick smoke test
```
