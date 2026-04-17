---
ok: false
schema_version: "2"
command: arxiv.search
duration_ms: 201
surface: web
operator: fetch
---

## Error

- **code**: invalid_input
- **message**: Search query is required but was empty. Provide a search term.
- **adapter_path**: src/adapters/arxiv/search.yaml
- **step**: 1
- **retryable**: false

## Suggestion

Pass a non-empty query string: `unicli arxiv search "LLM agents"`

## Alternatives

- `unicli arxiv recent`
- `unicli arxiv category cs.AI`
