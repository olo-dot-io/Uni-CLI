#!/usr/bin/env bash
# Demo session used by `scripts/gen-demo.sh` to generate docs/demo/demo.svg.
# Runs end-to-end in ~35 seconds. Sleeps are cosmetic — they let the viewer
# read each command before the next one scrolls by.
#
# Commands are chosen to showcase: (1) discovery, (2) public web API,
# (3) piping to jq, (4) bilingual search, (5) MCP exposure.
set -euo pipefail

PROMPT='\033[1;36m$\033[0m '

say() {
  printf "%b%s\n" "$PROMPT" "$1"
}

pause() {
  sleep "${1:-1.2}"
}

clear

say 'unicli list | head -5'
pause
unicli list 2>/dev/null | head -5 || echo "(unicli not installed — run: npm install -g @zenalexa/unicli)"
pause 2

say 'unicli hackernews top --limit 3'
pause
unicli hackernews top --limit 3 2>/dev/null || echo "(demo mode)"
pause 2

say 'unicli hackernews top --limit 5 --json | jq -r "[.[].score] | add"'
pause
unicli hackernews top --limit 5 --json 2>/dev/null | jq -r '[.[].score] | add' || echo "(demo mode)"
pause 2

say 'unicli search "推特热门"'
pause
unicli search "推特热门" 2>/dev/null | head -5 || echo "(demo mode)"
pause 2

say 'unicli mcp serve --transport streamable --port 19826 &'
pause
echo '[mcp] transport=streamable port=19826 endpoint=/mcp'
echo '[mcp] tools=4 (unicli_run, unicli_list, unicli_search, unicli_explore)'
echo '[mcp] ready'
pause 2

say '# CLI is all agents need.'
pause 2
