<!-- Generated from docs/guide/internet-access.md. Do not edit this copy directly. -->

# Internet Access

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/internet-access
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/internet-access.md
- Section: Use Uni-CLI
- Parent: Use Uni-CLI (/guide/)

Verified on 2026-10-10 against the current workspace, official provider contracts, and live public endpoints. Local command discovery, remote source search, and document reading have separate measurement boundaries.

## Find and execute a source

`search` ranks the installed operation catalog locally. A source command performs the network request. Specify the source when the task requires its records.

```bash
unicli search "search DBLP papers about graph databases" -f json
unicli describe dblp search --full -f json
unicli dblp search "graph databases" --limit 10 --offset 0 -f json
unicli retrieval search "graph databases" --sources dblp,arxiv --limit 10 -f json
```

The command router combines bilingual lexical retrieval, exact operation and site matches, and intent-specific ranking. Source-specific topical paper queries retain their named site's search route. Requests for a paper's code, reviews, or data keep the corresponding resource workflow. Cross-source retrieval merges canonical URLs using the best rank from each independent source. Repeated rows from one source contribute once. Requested chronological sorting runs before the final result limit.

## Read an agent-oriented representation

```bash
unicli extract https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/ --max-chars 12000 -f json
unicli web read https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/ -f json
unicli extract https://example.com --as html -f json
```

Markdown reads prefer `Accept: text/markdown`. Native Markdown passes through unchanged. HTML falls back to the existing content converter. Explicit HTML reads keep HTML negotiation. [Cloudflare's native representation](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/) provides this path through ordinary HTTP content negotiation.

`extract` includes the requested and final URLs, retrieval time, content type, headings, links, and truncation metadata. Direct text responses have a five-million-byte limit and a 30-second read deadline. `web read` preserves its string result and reports `response_too_large` above one million characters. Use `extract --max-chars` for an explicitly bounded evidence record.

## Academic and model sources

| Source     | Current path                                  | Pagination and identity                                                |
| ---------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| DBLP       | Official search API and author XML            | `--offset`, source totals, author PID, year-sorted author publications |
| OpenReview | Official paper search with `source=papers`    | `--offset`, v1/v2 content fields, author profile IDs                   |
| OpenRouter | Native model search and single-model metadata | `--limit`, `--offset`, `--sort`, canonical model slug                  |

```bash
unicli dblp author "Yann LeCun" --limit 10 --offset 0 -f json
unicli openreview search "diffusion" --limit 10 --offset 0 -f json
unicli openrouter search "gpt-5" --limit 2 --sort newest -f json
unicli openrouter model openai/gpt-5.6-luna -f json
unicli openrouter search "gpt-5" --limit 2 --fresh true -f json
```

OpenRouter search sends the query and page size to the server. Its public list and detail caches use the observed 120-second and 300-second freshness bounds, further restricted by each response's cache policy. `--fresh true` bypasses the stored response. Shared GET caches separate request headers, including credentials and content negotiation, and publish atomically. Writes always execute through their request path.

On the verification date, OpenRouter search and detail returned live data. DBLP returned an Anubis verification page. The configured OpenReview credential had expired. DBLP now reports `challenge_required` with a recovery action, and OpenReview reports the credential failure. Deterministic lifecycle scenarios separately exercise their successful payloads, pagination, cancellation, and recovery.

## Recover with the source contract

| Response                                 | Agent action                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `challenge_required`                     | Use an available official API or a browser reader; credential-aware adapters follow their declared authentication flow |
| Authentication failure                   | Run `unicli auth setup <site>` and refresh the declared credential                                                     |
| HTTP 429 or a retryable upstream failure | Respect `Retry-After`; cancellation interrupts the wait                                                                |
| `invalid_content`                        | Inspect the expected MIME and API endpoint                                                                             |
| `operation_outcome_ambiguous`            | Read the current resource state before repeating an accepted write                                                     |

The shared HTTP owner recognizes `cf-mitigated: challenge` before content parsing. Its HTML fallback combines a verification-page heading with challenge-specific content, keeping ordinary Turnstile documentation readable. Retry windows support seconds and HTTP dates. Failed response bodies are released before another attempt. Interrupted read responses use the remaining attempt budget. An accepted write with an interrupted response returns an ambiguous outcome for reconciliation.

[Cloudflare Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/) requires a recognized operator key and verified HTTP signatures. Admission remains a source-side decision. The implementation provides content negotiation, challenge classification, and adapter-specific authenticated-session recovery. Public direct readers, including `extract`, `web read`, and DBLP requests, do not import browser cookies. Browser verification affects a later API retry only through an adapter that explicitly declares and consumes those credentials. Web Bot Auth enrollment and a general CAPTCHA solver are outside the implemented capability set.

## Compare the appropriate boundary

[Exa](https://exa.ai/docs/reference/search) exposes hosted web search with content extraction, domain filters, dates, and result limits. [Context7](https://context7.com/docs/api-guide) exposes documentation search with library selection, version hints, and snippet reranking. Uni-CLI routes local operations and composes registered sources with execution and recovery.

The [benchmark report](/BENCHMARK) compares local routing with BM25, TF-IDF, and MiniSearch on a shared catalog, and measures live native Markdown and OpenRouter response sizes separately. Hosted Exa and Context7 search quality requires its own shared query set, credentials, and relevance judgments. The local-routing result establishes performance within its measured catalog.
