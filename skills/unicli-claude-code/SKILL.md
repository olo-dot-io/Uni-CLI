---
name: unicli-claude-code
description: >
  Make Uni-CLI reliable when invoked from Claude Code. MANDATES JSON-in
  channels (stdin / --args-file) for any payload containing quotes, emoji,
  newlines, or inline JSON — shell-quoted invocations hit TC0 circuit
  limits and drop to <50% success above ICS=4. Also covers --describe
  introspection and next_actions-driven navigation.
version: 0.217.0
depends-on:
  - talk-normal
triggers:
  - "unicli"
  - "ics"
  - "args-file"
  - "stdin-json"
  - "quoted payload"
  - "emoji in query"
---

# Uni-CLI × Claude Code — Reliable Invocation

> **TL;DR** — If the payload contains ANY of: quotes, emoji, newlines, JSON,
> non-ASCII, or is longer than ~60 chars, PIPE IT. Never inline.

## Why this skill exists

Transformers live in TC0. Matching balanced `"` and `'` pairs with arbitrary
nesting is a mod-2 state-tracking problem that TC0 cannot solve in constant
decode depth. Empirically, top LLMs land <43% on 0→1 CLI generation
(CLI-Tool-Bench arXiv:2604.06742) and 62% of agent-tool bugs cluster at the
tool-invocation / execution stages (arXiv:2603.20847).

Uni-CLI gives you THREE invocation channels. One of them (shell-args) inherits
the TC0 bottleneck. The other two do not.

## The decision rule

| If the payload has …                     | Use channel     |
| ---------------------------------------- | --------------- |
| Only ASCII, no quotes, <60 chars         | `shell` OK      |
| Any quote or backslash                   | **stdin-JSON**  |
| Emoji / CJK / non-ASCII                  | **stdin-JSON**  |
| Newlines or inline JSON                  | **stdin-JSON**  |
| Being reused across multiple invocations | **--args-file** |

When unsure → stdin-JSON. It never makes things worse.

## The three channels

### 1 — stdin-JSON (preferred for complex payloads)

```bash
echo '{"query": "she said \"hi\" 🎉", "limit": 10}' | unicli twitter search
```

- Uni-CLI auto-detects non-TTY stdin whose body starts with `{`
- Precedence: stdin-JSON > `--args-file` > shell flags > defaults
- Works for EVERY command — no per-adapter opt-in needed

### 2 — --args-file (preferred when payload is reused)

```bash
cat > /tmp/q.json <<'EOF'
{ "query": "machine learning", "limit": 20, "locale": "en_US" }
EOF
unicli arxiv search --args-file /tmp/q.json
```

- Absolute paths recommended
- JSON only (YAML and TOML deliberately not supported — minimize format ambiguity)

### 3 — shell args (only for trivial payloads)

```bash
unicli hackernews top --limit 5
```

Fine when every value is ASCII, no quotes, no emoji.

## Runtime introspection — `unicli describe`

Before invoking any unfamiliar command, run:

```bash
unicli describe <site> <command>
```

You get back a JSON object containing:

- `args_schema` — JSON Schema draft-2020-12 for the argument bag
- `example_stdin` — a realistic JSON body you can modify and pipe
- `channels` — the three invocation templates
- `next_actions` — hints for what to run next

This replaces reading docs. The CLI is the documentation.

## The response envelope (v2)

Every successful call returns:

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "twitter.search",
  "meta": { "duration_ms": 847, "count": 10, "surface": "web" },
  "data": [ ... ],
  "error": null,
  "next_actions": [
    { "command": "unicli describe twitter search", "description": "…" },
    { "command": "unicli twitter search --args-file <path.json>", "description": "…" }
  ]
}
```

Errors return `ok: false` with a structured `error` object (`adapter_path`,
`step`, `suggestion`) and `next_actions` biased toward `unicli repair`. If
you see `invalid_input` from the hardening layer, that means the arg bag
tripped a safety check — read `error.suggestion` for the exact fix.

## --dry-run — preview before committing

```bash
echo '{"query": "🎉", "limit": 5}' | unicli twitter search --dry-run
```

Prints the resolved ArgBag, the source channel, and the pipeline step count
without touching the network / filesystem. Use this whenever you want to
confirm the agent built the payload correctly.

## Common failure modes → fixes

| Symptom                                       | Root cause                             | Fix                                       |
| --------------------------------------------- | -------------------------------------- | ----------------------------------------- |
| `invalid_input: control characters`           | Embedded 0x01..0x1F in a string arg    | Strip control chars; use \\t \\n \\r only |
| `invalid_input: path escapes CWD`             | `../` or absolute path outside $HOME   | Keep outputs inside cwd or $HOME/.unicli  |
| `invalid_input: id contains URL punctuation`  | You pasted a full URL as a resource id | Strip the `?`, `#`, or `%XX` sequences    |
| Command appears to run but gets wrong args    | Shell ate your quotes                  | Switch to stdin-JSON                      |
| Unexpected shell expansion (`$HOME`, `` ` ``) | Bash interpolated your payload         | Single-quote, or better, use stdin-JSON   |

## Recipes

### Search with a complex query

```bash
printf '%s\n' '{"query": "large language models \"emergent\" behaviour", "limit": 25}' \
  | unicli arxiv search
```

### Multi-arg desktop command

```bash
cat > /tmp/render.json <<'EOF'
{ "scene": "/Users/me/project/main.blend", "output_dir": "~/renders", "frame_start": 1, "frame_end": 240 }
EOF
unicli blender render --args-file /tmp/render.json
```

### Debug-first workflow

```bash
unicli describe youtube transcript         # 1. understand the contract
echo '{"url": "https://…"}' | unicli youtube transcript --dry-run   # 2. preview
echo '{"url": "https://…"}' | unicli youtube transcript             # 3. run
```

## Version contract

- v0.214.0+ required for stdin-JSON auto-detect, `--describe`, and consistent MCP tool discovery metadata
- v0.213.1 or earlier agents should fall back to `unicli schema <site> <cmd>`
  and explicit `--` flag args
