---
ok: false
schema_version: "2"
command: reddit.frontpage
duration_ms: 3201
surface: web
operator: fetch
---

## Error

- **code**: rate_limited
- **message**: Reddit API returned HTTP 429 Too Many Requests. Retry after 60 seconds.
- **adapter_path**: src/adapters/reddit/frontpage.yaml
- **step**: 1
- **retryable**: true

## Suggestion

Back off and retry after 60 seconds. Consider adding a rate_limit step to the adapter.

## Alternatives

- `unicli reddit hot`
- `unicli reddit rising`
