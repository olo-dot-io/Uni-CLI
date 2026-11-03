---
"@zenalexa/unicli": patch
---

`ai pulse` ranks what mattered in its window. Sources that bound a `--since` window themselves (GitHub through qualifiers, docs, Bluesky) rank inside it by relevance or engagement: repositories by stars, issues and pull requests by reactions. Other sources keep newest-first so the window fills. The pulse orders rows by their fused rank across query lanes, with time as the tie-break, and `--window all` stays newest-first. Unscoped GitHub issue and pull-request search leaves the default pulse lanes and joins only when `--sources` names it. Role profiles pulse on short field phrases, such as `AI agent`, `coding agent` and `MCP`, that paper, model-hub and community sources match. `gh search-repos`, `search-issues` and `search-prs` take the retrieval sort and order.
