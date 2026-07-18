---
"@zenalexa/unicli": patch
---

Replace the CLI-only usage counter with a bounded, owner-only local event log
covering CLI, MCP, ACP, bench, and hub adapter calls. Diagnostic events now
carry version plus stabilized clean/dirty source identity, trace, transport,
surface, parent/child operation role, outcome, latency, result size, and typed
failure metadata while excluding arguments, content, URLs, credentials, raw
errors, and adapter filesystem paths. Complete lock owners are durably
published, dead owners and abandoned candidates are reclaimed by exact inode,
dual operation/release failures remain visible, and bounded readers reject
symlinks, identity changes, and oversized files before loading bytes.

Make `unicli usage report` combine legacy and current evidence, distinguish
transports, reject invalid windows and limits, and surface corrupt or
unreadable JSONL through structured error envelopes instead of silently
dropping records. CLI and MCP request boundaries sanitize unknown user tokens,
correlate direct kernel work without double counting, and preserve allowlisted
tool error types.

Normalize Commander parser failures through the same structured envelope and
local-event boundary: unknown options and missing values now use stable
`invalid_input` diagnostics without echoing raw user tokens.
