---
ok: false
schema_version: "2"
command: douban.book-hot
duration_ms: 312
surface: web
operator: fetch
---

## Error

- **code**: upstream_error
- **message**: Douban returned HTTP 404 for /j/search_subjects. The hot-books endpoint has been removed.
- **adapter_path**: src/adapters/douban/book-hot.yaml
- **step**: 1
- **retryable**: false

## Suggestion

This adapter is quarantined (endpoint removed 2026-04-15). Use `unicli douban book-search <keyword>` instead.

## Alternatives

- `unicli douban book-search <keyword>`
- `unicli douban book-rank`
