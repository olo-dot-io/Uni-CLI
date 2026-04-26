# Recipes

Worked examples showing how agents chain Uni-CLI commands to solve real
end-user tasks.

All examples assume:

- Uni-CLI is on `$PATH` (`npm install -g @zenalexa/unicli`)
- Commands that feed `jq` or shell scripts pass `-f json` explicitly

## 1. Triage your morning inbox — list iMessages + Notes in one JSON blob

**Use-case.** An agent needs a single structured view of "what the user
might be behind on" across iMessage and Apple Notes before drafting a
stand-up update.

### Command sequence

```bash
# Recent messages from the last hour (take the top 10 for brevity)
unicli imessage recent --limit 10 -f json > /tmp/recent-msgs.json

# Your "Work" notes folder (titles only — body fetch is a separate call)
unicli apple-notes list --folder "Work" -f json > /tmp/work-notes.json

# Merge client-side (bash):
jq -n --slurpfile m /tmp/recent-msgs.json \
      --slurpfile n /tmp/work-notes.json \
      '{messages: $m[0], notes: $n[0]}'
```

### Expected output

```json
{
  "messages": [
    {
      "ts": "2026-04-15 08:42:11",
      "is_from_me": 0,
      "handle_id": "+14155550123",
      "text": "Standup at 10?"
    }
  ],
  "notes": [
    { "stdout": "Roadmap Q2\nFollow-ups from design review\nOKR draft" }
  ]
}
```

### Troubleshooting

- `imessage recent` returns `[]` on non-macOS hosts. The adapter gates
  on `uname = Darwin` and exits cleanly.
- If you see `OSError: Operation not permitted`, grant your terminal
  Full Disk Access under **System Settings → Privacy & Security → Full
  Disk Access**.
- `apple-notes list` returns an empty `stdout` when the folder does not
  exist. AppleScript does not distinguish "empty folder" from "missing
  folder" — confirm with `unicli apple-notes list` (default "Notes"
  folder) first.

## 2. Auto-file a Linear bug from a user iMessage

**Use-case.** The agent scans recent iMessage for the phrase "bug:" and
opens a Linear issue so nothing slips through.

### Command sequence

```bash
# Step 1 — search iMessage for the phrase
unicli imessage search "bug:" --limit 5 -f json > /tmp/bug-msgs.json

# Step 2 — extract the first message body (agent logic in jq)
TITLE=$(jq -r '.[0].text' /tmp/bug-msgs.json | head -c 120)

# Step 3 — file the Linear issue
export LINEAR_API_KEY=lin_api_xxxxxxxxxxxx
unicli linear issue-create "$TITLE" \
  --team ENG \
  --description "Auto-filed from iMessage on $(date -Iseconds)" \
  -f json
```

### Expected output

```json
[
  {
    "identifier": "ENG-742",
    "title": "bug: settings page 500s when language=zh-hk",
    "url": "https://linear.app/my-team/issue/ENG-742"
  }
]
```

### Troubleshooting

- If `LINEAR_API_KEY` is unset, the Linear API returns `401
Authentication required` — the adapter surfaces this as a structured
  error with `exit_code: 77` (AUTH_REQUIRED).
- Omitting `--team` works if your workspace has a default team.
  Otherwise Linear returns a GraphQL error telling you which field is
  missing; Uni-CLI emits that verbatim in `stderr`.
- Linear's Authorization header is the API key itself, **not** `Bearer
KEY`. If you see `403 Forbidden`, double-check you didn't prepend
  `Bearer`.

## 3. Close a Linear issue from a note you just wrote

**Use-case.** You finish a task, write a "done: ENG-123" note, and want
the Linear state flipped to Done without leaving the terminal.

### Command sequence

```bash
# Step 1 — search notes for the completion marker
unicli apple-notes search "done: ENG-" -f json > /tmp/done-notes.json

# Step 2 — extract the Linear identifier from the first match (agent
# logic). Here we assume the note body is a single line "done: ENG-123".
ID=$(jq -r '.[0].stdout' /tmp/done-notes.json \
     | grep -oE 'ENG-[0-9]+' | head -1)

# Step 3 — flip the state
export LINEAR_API_KEY=lin_api_xxxxxxxxxxxx
unicli linear issue-update "$ID" --state "Done" -f json
```

### Expected output

```json
[
  {
    "identifier": "ENG-123",
    "title": "Ship Phase 5 adapters",
    "url": "https://linear.app/my-team/issue/ENG-123"
  }
]
```

### Troubleshooting

- `issue-update` makes three HTTP calls (fetch issue → resolve state →
  apply update). If any step returns an empty result, the final
  mutation silently does nothing. Use `-f json` to inspect the
  intermediate pipeline via `unicli dev` — see
  `docs/guide/getting-started.md`.
- State names are case-sensitive and team-scoped. "Done" in one team
  might be "Shipped" in another; list states per team with
  `unicli linear issue-list --state Done --limit 1` to confirm a
  working name.

## 4. Stand-up digest — what changed since yesterday?

**Use-case.** Generate a one-page summary for your daily stand-up
combining: yesterday's Linear Done issues + any iMessage threads
mentioning them.

### Command sequence

```bash
export LINEAR_API_KEY=lin_api_xxxxxxxxxxxx

# Step 1 — Linear issues in "Done" state, top 10
unicli linear issue-list --state "Done" --limit 10 -f json > /tmp/done-issues.json

# Step 2 — for each issue, search iMessage for its identifier
for ID in $(jq -r '.[].id' /tmp/done-issues.json); do
  echo "=== $ID ==="
  unicli imessage search "$ID" --limit 3 -f json
done > /tmp/digest.json

# Step 3 — hand the blob to your LLM of choice, which can now cite
# specific messages that corroborate each shipped issue.
```

### Expected output

Mixed `=== ENG-42 ===` headers followed by JSON arrays of messages
mentioning `ENG-42`. Consumers typically pipe this to an LLM that
summarises in 3-5 bullets.

### Troubleshooting

- `issue-list` returns only issues you have access to — API key scope
  matters. A read-only key will not list other users' private projects.
- iMessage `search` is `LIKE` over the full `chat.db`. For large
  databases (>100K messages) a query takes 1-3 seconds. Avoid running
  it in a tight loop with >50 iterations.

## Common flags

All Phase 5 adapters support:

| Flag             | What it does                                      |
| ---------------- | ------------------------------------------------- |
| `-f json`        | Machine output (auto-on when stdout is not a TTY) |
| `-f yaml` / `md` | Human-readable alternatives                       |
| `--limit N`      | Caps row count where applicable                   |

Exit codes follow `sysexits.h`:

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| 0    | Success                                  |
| 66   | Empty result (not an error)              |
| 69   | Service unavailable (non-darwin, no key) |
| 77   | Auth required (`LINEAR_API_KEY` unset)   |
| 78   | Config error (malformed adapter)         |

See `docs/reference/exit-codes.md` for how agents detect and handle each
exit code.
