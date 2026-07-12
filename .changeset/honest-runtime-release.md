---
"@zenalexa/unicli": minor
---

Make production truth consistent across runtime, repair, credentials, startup,
CI, and documentation. HTTP execution now uses one Undici implementation for
fetch and proxy dispatch, repair verifies the original command without hidden
mutation, cookie persistence is explicit and owner-only, update checks are
detached and target the scoped package, Node 22/24 and production audits are
release gates, and the executable built-in action surface is registry-derived
and budgeted.
