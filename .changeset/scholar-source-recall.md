---
"@zenalexa/unicli": minor
---

Search each scholarly source through its query command, so arXiv rows in `scholar search` come from `arxiv search` and match the query.

Push `--year` into each source's own API. `scholar search --year` and the arXiv, Crossref, OpenAlex, PubMed and Semantic Scholar searches accept one year or a range such as `2024-2026`; DBLP filters a single year.

Report `SCHOLAR_SOURCES_UNAVAILABLE` with each source's state when a source failed and no rows came back, exiting 75 when the failure is retryable. A `*_NOT_FOUND` code now means every source answered.

Keep arXiv rows that the API matched by word stem, ranking exact matches first. `arxiv search --sort` accepts `newest` and `updated`.
