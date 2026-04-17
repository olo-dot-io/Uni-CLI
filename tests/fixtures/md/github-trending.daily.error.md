---
ok: false
schema_version: "2"
command: github-trending.daily
duration_ms: 2103
surface: web
operator: fetch
---

## Error

- **code**: api_error
- **message**: GitHub Search API returned 422 Unprocessable Entity: pushed date filter is invalid.
- **adapter_path**: src/adapters/github-trending/daily.yaml
- **step**: 1
- **retryable**: false

## Suggestion

Update the pushed date filter in the adapter YAML. Run `unicli repair github-trending daily`.

## Alternatives

- `unicli github-trending weekly`
- `unicli github-trending monthly`
