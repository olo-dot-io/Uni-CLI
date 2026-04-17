---
ok: false
schema_version: "2"
command: xiaohongshu.feed
duration_ms: 8001
surface: web
operator: cdp-native
---

## Error

- **code**: selector_miss
- **message**: Pinia store action fetchFeeds not intercepted within 8000ms timeout on xiaohongshu.com/explore
- **adapter_path**: src/adapters/xiaohongshu/feed.yaml
- **step**: 2
- **retryable**: true

## Suggestion

Xiaohongshu may have updated its Pinia store structure. Run `unicli repair xiaohongshu feed` to re-record the tap action.

## Alternatives

- `unicli xiaohongshu search <keyword>`
- `unicli xiaohongshu user <uid>`
