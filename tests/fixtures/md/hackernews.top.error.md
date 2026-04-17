---
ok: false
schema_version: "2"
command: hackernews.top
duration_ms: 8502
surface: web
operator: fetch
---

## Error

- **code**: network_error
- **message**: HN Firebase API request timed out after 8000ms. hacker-news.firebaseio.com unreachable.
- **adapter_path**: src/adapters/hackernews/top.yaml
- **step**: 1
- **retryable**: true

## Suggestion

Check network connectivity. The Firebase endpoint may be temporarily unavailable. Retry in a few minutes.

## Alternatives

- `unicli hackernews new`
- `unicli hackernews ask`
