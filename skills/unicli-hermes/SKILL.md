---
name: unicli
description: >
  Use Uni-CLI to interact with 200+ websites, desktop apps, and system tools.
  Trigger when: user asks to check a website, fetch data, control a desktop app,
  or interact with social media, news, finance, or AI platforms.
version: 0.211.0
triggers:
  - "unicli"
  - "website"
  - "fetch from"
  - "check twitter"
  - "bilibili"
  - "hackernews"
---

# Uni-CLI Agent Skill

Universal CLI for AI agents — 200 sites, 969 commands.

## Install

```bash
npm install -g @zenalexa/unicli
```

## Quick Reference

```bash
unicli <site> <command> [--limit N] [--json]   # Run any command
unicli list [--site <name>]                     # Discover commands
unicli schema <site> <command>                  # Get input/output schema
unicli repair <site> <command>                  # Fix broken adapter
unicli test <site>                              # Validate adapter
```

## When to Use

- **Web data**: `unicli twitter search "query"`, `unicli hackernews top`
- **Chinese platforms**: `unicli bilibili hot`, `unicli zhihu trending`
- **Finance**: `unicli bloomberg latest`, `unicli xueqiu hot`
- **Desktop apps**: `unicli blender render scene.blend`, `unicli ffmpeg compress video.mp4`
- **macOS system**: `unicli macos volume 50`, `unicli macos screenshot`

## Output

- Piped (non-TTY): automatic JSON
- Terminal: human-readable table
- Errors: structured JSON to stderr with `adapter_path`, `step`, `suggestion`

## Self-Repair

When a command fails:

1. Read the error JSON — it includes the adapter file path
2. Read the YAML adapter (~20 lines)
3. Fix the issue (selector changed? API versioned? auth needed?)
4. Save to `~/.unicli/adapters/<site>/<command>.yaml`
5. Verify: `unicli repair <site> <command>`

## MCP Server (Hermes / agentskills.io)

Add to your Hermes agent configuration:

```yaml
mcp_servers:
  unicli:
    command: "npx"
    args: ["-y", "@zenalexa/unicli", "mcp", "serve"]
    tools:
      include: [unicli_run, unicli_list, unicli_discover]
```

Or run the expanded server to expose all 969 commands as individual tools:

```yaml
mcp_servers:
  unicli:
    command: "npx"
    args: ["-y", "@zenalexa/unicli", "mcp", "serve", "--expanded"]
```
