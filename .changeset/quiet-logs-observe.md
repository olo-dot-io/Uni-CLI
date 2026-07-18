---
"@zenalexa/unicli": patch
---

Replace the CLI-only usage counter with a bounded, owner-only local event log
covering CLI, MCP, ACP, bench, and hub adapter calls. Diagnostic events now
carry version/revision, trace, transport, surface, outcome, latency, result
size, and typed failure metadata while excluding arguments, content, URLs,
credentials, and raw errors.

Make `unicli usage report` combine legacy and current evidence, distinguish
transports, reject invalid windows and limits, and surface corrupt or
unreadable JSONL through structured error envelopes instead of silently
dropping records.
