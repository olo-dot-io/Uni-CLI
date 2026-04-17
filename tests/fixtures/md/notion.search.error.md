---
ok: false
schema_version: "2"
command: notion.search
duration_ms: 621
surface: web
operator: fetch
---

## Error

- **code**: permission_denied
- **message**: Notion API returned 403 Forbidden. Session cookie is valid but lacks access to this workspace.
- **adapter_path**: src/adapters/notion/search.yaml
- **step**: 1
- **retryable**: false

## Suggestion

Ensure you are logged in to the correct Notion workspace. Run `unicli auth setup notion` to refresh cookies.

## Alternatives

- `unicli notion page <id>`
- `unicli notion database <id>`
