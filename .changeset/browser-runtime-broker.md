---
"@zenalexa/unicli": minor
---

Replace per-command browser ownership and the legacy HTTP daemon with an
authenticated machine-wide Browser Runtime Broker. Agent sessions now share
hidden managed, existing-Chrome, or remote providers while retaining distinct
target leases, explicit handoff, profile partitions, turn cleanup, idle TTL,
crash recovery, and transport-independent CLI/MCP/plugin identity. Browser
status and doctor commands expose provider, visibility, lease, policy, and
pending-release truth without creating a browser window.
