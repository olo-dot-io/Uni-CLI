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

Expose prepared-target browser state, screenshots, navigation, trusted ref and
viewport input, tabs, bounded open-tab/history search, dialog/download
supervision, and explicit foreground edge/cursor presence directly through the
generic `computer-use` MCP profile. Search and background control never focus
or switch tabs; sensitive and Agent-owned visual content is omitted from
snapshots and search results.
