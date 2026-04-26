# Demo assets

The README embeds `demo.svg` from this directory as the opening visual.

## Re-generate

`demo.svg` is produced by `scripts/gen-demo.sh`, which drives `scripts/demo-session.sh`
through asciinema and renders an SVG terminal animation with `svg-term-cli`.

```bash
# One-time install
brew install asciinema           # or: pipx install asciinema
npm install -g svg-term-cli

# Record + render
bash scripts/gen-demo.sh
```

The script overwrites both `docs/demo/session.cast` (raw asciinema cast)
and `docs/demo/demo.svg` (rendered animation). Commit both when the demo
flow changes — GitHub renders SVGs inline in the README without running
the recorder.

## Fallback

If asciinema is unavailable on the host, the repository ships a static
hand-drawn SVG at `docs/demo/demo.svg` that mirrors the session content.
A maintainer should re-run `scripts/gen-demo.sh` on a machine with the
tooling installed to upgrade it to the animated version.

## What the demo covers

In ~35 seconds, `scripts/demo-session.sh` shows:

1. `unicli list | head -5` — discovery
2. `unicli hackernews top --limit 3` — zero-config web API
3. `unicli hackernews top --limit 5 --json | jq '...'` — piping + JSON
4. `unicli search "twitter trending"` — intent search
5. `unicli mcp serve --transport streamable --port 19826` — MCP exposure

That sequence is the minimum surface an agent touches on first use.
