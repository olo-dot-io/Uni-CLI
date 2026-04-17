---
ok: false
schema_version: "2"
command: zhihu.answers
duration_ms: 389
surface: web
operator: fetch
---

## Error

- **code**: auth_required
- **message**: Zhihu API returned 401 Unauthorized. z_c0 cookie is missing or has expired.
- **adapter_path**: src/adapters/zhihu/answers.yaml
- **step**: 1
- **retryable**: false

## Suggestion

Run `unicli auth setup zhihu` to refresh the z_c0 session cookie, then retry.

## Alternatives

- `unicli zhihu trending`
- `unicli zhihu question <id>`
