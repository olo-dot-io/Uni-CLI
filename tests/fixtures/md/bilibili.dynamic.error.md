---
ok: false
schema_version: "2"
command: bilibili.dynamic
duration_ms: 441
surface: web
operator: fetch
---

## Error

- **code**: not_authenticated
- **message**: Bilibili API returned code -101: account not logged in. SESSDATA cookie is missing or expired.
- **adapter_path**: src/adapters/bilibili/dynamic.yaml
- **step**: 1
- **retryable**: false

## Suggestion

Run `unicli auth setup bilibili` to refresh your cookies, then retry.

## Alternatives

- `unicli bilibili hot`
- `unicli bilibili trending`
