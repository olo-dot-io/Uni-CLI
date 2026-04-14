#!/usr/bin/env bash
# gen-demo — Record scripts/demo-session.sh with asciinema and render
# an SVG animation to docs/demo/demo.svg for the README.
#
# Prerequisites (install once):
#   brew install asciinema           # macOS
#   pipx install asciinema           # any OS
#   npm install -g svg-term-cli      # renderer
#
# The generated docs/demo/demo.svg is committed so the README always
# renders even on GitHub's web view (which does not execute the script).
# Re-run this whenever the demo flow changes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CAST="$ROOT/docs/demo/session.cast"
SVG="$ROOT/docs/demo/demo.svg"

if ! command -v asciinema >/dev/null 2>&1; then
  echo "gen-demo: asciinema not found. Install it first:"
  echo "  brew install asciinema    # or: pipx install asciinema"
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "gen-demo: npx not found. Install Node.js 20+."
  exit 1
fi

mkdir -p "$(dirname "$CAST")"

echo "gen-demo: recording demo session -> $CAST"
asciinema rec \
  --cols 80 \
  --rows 24 \
  --overwrite \
  --command "bash $ROOT/scripts/demo-session.sh" \
  "$CAST"

echo "gen-demo: rendering SVG -> $SVG"
npx --yes svg-term-cli \
  --in "$CAST" \
  --out "$SVG" \
  --width 80 \
  --height 24 \
  --window \
  --padding 16

echo "gen-demo: done. Preview: open $SVG"
