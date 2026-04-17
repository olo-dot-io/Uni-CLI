---
ok: false
schema_version: "2"
command: twitter.mentions
duration_ms: 5012
surface: web
operator: cdp-native
---

## Error

- **code**: selector_miss
- **message**: Element article[data-testid='tweet'] not found after 4000ms on /notifications/mentions
- **adapter_path**: src/adapters/twitter/mentions.yaml
- **step**: 3
- **retryable**: true

## Suggestion

Twitter UI may have changed. Run `unicli repair twitter mentions` to re-record the selector.

## Alternatives

- `unicli twitter list`
- `unicli twitter user <handle>`
