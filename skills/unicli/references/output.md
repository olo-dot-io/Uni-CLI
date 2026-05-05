# AgentEnvelope v2 — Output Format Reference

All unicli commands emit a **v2 AgentEnvelope**. This is the stable machine contract
since v0.215. This reference covers every field, error codes, parsing patterns, and
format-specific behavior.

---

## Complete Schema

```typescript
// Success envelope
{
  ok: true,
  schema_version: "2",          // always "2"
  command: "site.command",      // e.g. "hackernews.top"
  meta: {
    duration_ms: number,        // wall-clock time in ms
    count?: number,             // rows in data[]
    surface?: "web" | "desktop" | "system" | "mobile",
    adapter_version?: string,   // YAML/TS adapter version string
    operator?: string,          // browser operator handle if used
    pagination?: {
      next_cursor?: string,     // opaque cursor; pass via --cursor
      has_more?: boolean,       // true when more pages exist
    }
  },
  data: T[],                    // payload — array or object depending on adapter
  error: null,
  next_actions: AgentNextAction[]
}

// Failure envelope
{
  ok: false,
  schema_version: "2",
  command: "site.command",
  meta: { duration_ms: number },
  data: null,
  error: {
    code: string,               // see error code table below
    exit_code: number,          // sysexits.h aligned
    message: string,            // human-readable
    adapter_path?: string,      // YAML file to repair (if applicable)
    step: number,               // pipeline step index that failed (0-based)
    retryable: boolean,         // true = retry after fix; false = args/config issue
    suggestion: string,         // what to do next
    remedy?: {
      message: string,
      command?: string,         // exact CLI command to run as remedy
      deeplink?: string,
      doc?: string
    },
    diff_candidate?: string,    // suggested YAML diff for repair
    minimum_capability?: string // e.g. "browser.cdp" — needed transport
  },
  next_actions: AgentNextAction[]
}
```

---

## Error Code Reference

### Transport / network (5 codes)

| Code                | Exit | Meaning                             | Action                                  |
| ------------------- | ---- | ----------------------------------- | --------------------------------------- |
| `network_error`     | 75   | TCP/TLS/DNS failure, timeout        | Retry once; check connectivity          |
| `rate_limited`      | 75   | 429 or upstream quota               | Wait and retry; reduce `--limit`        |
| `upstream_error`    | 75   | 5xx or malformed body from upstream | Retry; if persists load `unicli-repair` |
| `api_error`         | 1    | 4xx non-auth error                  | Read `message` + `suggestion`           |
| `not_authenticated` | 77   | Credentials expired or missing      | `unicli auth setup <site>`              |

### Input / validation (3 codes)

| Code            | Exit | Meaning                        | Action                                   |
| --------------- | ---- | ------------------------------ | ---------------------------------------- |
| `invalid_input` | 2    | Arg failed validation          | Fix args; `unicli describe <site> <cmd>` |
| `selector_miss` | 1    | CSS/XPath matched nothing      | Load `unicli-repair` — selector changed  |
| `not_found`     | 66   | HTTP 404 or "no such resource" | Check the resource ID or URL             |

### Authorization (2 codes)

| Code                | Exit | Meaning                       | Action                                 |
| ------------------- | ---- | ----------------------------- | -------------------------------------- |
| `auth_required`     | 77   | Missing cookie file           | `unicli auth setup <site>`             |
| `permission_denied` | 77   | Authenticated but lacks scope | Different account or check permissions |

### Runtime (2 codes)

| Code             | Exit | Meaning                             | Action                                              |
| ---------------- | ---- | ----------------------------------- | --------------------------------------------------- |
| `internal_error` | 1    | Uncaught exception in unicli        | Report to GitHub issues                             |
| `quarantined`    | 1    | Adapter gated by `quarantine:` flag | `unicli repair --quarantined`; load `unicli-repair` |

### Ref-locator (3 codes, browser mode only)

| Code            | Exit | Meaning                                | Action                                       |
| --------------- | ---- | -------------------------------------- | -------------------------------------------- |
| `stale_ref`     | 1    | Browser snapshot ref detached from DOM | Re-run `unicli browser state` for fresh refs |
| `ambiguous`     | 1    | Ref maps to multiple elements          | Use a more specific `--css` selector         |
| `ref_not_found` | 1    | Ref not in current snapshot            | Re-run `unicli browser state`                |

---

## next_actions — HATEOAS Navigation

`next_actions` are generated from the adapter schema. **Trust them** — they are not
suggested by an LLM but computed from the command's type, args, and response context.

```json
"next_actions": [
  {
    "command": "unicli describe hackernews top",
    "description": "Inspect the command's JSON schema, channels, and example payload"
  },
  {
    "command": "unicli hackernews top --args-file <path.json>",
    "description": "Re-run with a JSON payload from file",
    "params": {
      "path": {
        "description": "Absolute path to a JSON object file with command args"
      }
    }
  },
  {
    "command": "unicli hackernews top --cursor <next_cursor>",
    "description": "Fetch next page",
    "params": {
      "next_cursor": {
        "value": "eyJwIjoyLCJsIjoyNX0=",
        "description": "Pagination cursor from current response"
      }
    }
  }
]
```

`params[].value` pre-fills the value from the current response (e.g. the cursor).
`params[].enum` constrains valid choices. `params[].default` shows the implicit default.

---

## Output Format Comparison

| Format    | Flag              | Use case                                                |
| --------- | ----------------- | ------------------------------------------------------- |
| `md`      | default / `-f md` | Display to user; agent-native Markdown with frontmatter |
| `json`    | `-f json`         | Programmatic parsing with jq or code                    |
| `yaml`    | `-f yaml`         | Config-style output                                     |
| `csv`     | `-f csv`          | Spreadsheet export; array data only                     |
| `compact` | `-f compact`      | One row per line, `\|` separator; array data only       |

`UNICLI_OUTPUT=json` environment variable sets `json` globally without per-call flags.

---

## Parsing Patterns

### Extract titles

```bash
unicli hackernews top -f json | jq '.data[].title'
```

### Filter by field value

```bash
unicli xueqiu hot -f json | jq '.data[] | select(.change | tonumber > 5)'
```

### Extract nested field

```bash
unicli bilibili hot -f json | jq '.data[] | {title: .title, view: .stat.view}'
```

### Pagination loop

```bash
cursor=""
while true; do
  result=$(unicli reddit hot --limit 25 ${cursor:+--cursor $cursor} -f json)
  echo "$result" | jq '.data[].title'
  cursor=$(echo "$result" | jq -r '.meta.pagination.next_cursor // empty')
  has_more=$(echo "$result" | jq -r '.meta.pagination.has_more // false')
  [ "$has_more" = "true" ] || break
done
```

### Check success before parsing

```bash
result=$(unicli hackernews top -f json)
if echo "$result" | jq -e '.ok' >/dev/null 2>&1; then
  echo "$result" | jq '.data[].title'
else
  echo "Error: $(echo "$result" | jq -r '.error.message')"
  echo "Action: $(echo "$result" | jq -r '.error.suggestion')"
fi
```

### Error-first pattern (recommended)

```bash
unicli twitter search "AI agents" -f json | jq '
  if .ok then
    .data[] | {title: .text, author: .author}
  else
    "ERROR[\(.error.code)]: \(.error.message) → \(.error.suggestion)"
  end
'
```

---

## Surface Field

`meta.surface` indicates the access method used:

| Value     | Meaning                                       |
| --------- | --------------------------------------------- |
| `web`     | HTTP/REST API call                            |
| `desktop` | Local app via AppleScript / Accessibility API |
| `system`  | macOS system call                             |
| `mobile`  | Mobile device bridge                          |

---

## Schema Version History

| Version | Since       | Notes                             |
| ------- | ----------- | --------------------------------- |
| `2`     | v0.215      | Current. All agent-facing output. |
| `1`     | v0.1–v0.214 | Legacy. Removed in v0.215.        |

v2 is the only version. If you see `schema_version: "1"` in output, upgrade unicli.
