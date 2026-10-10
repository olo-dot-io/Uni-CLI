<!-- Generated from docs/guide/internet-access.md. Do not edit this copy directly. -->

# Internet Access

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/internet-access
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/internet-access.md
- Section: Use Uni-CLI
- Parent: Use Uni-CLI (/guide/)

Use Uni-CLI to find a source, search its records, and read the documents needed for a task. Start with local command discovery, run the selected source command, then retrieve content in a form an agent can consume. Each stage returns the information needed for the next call.

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

## Save a research collection

Use `retrieval acquire` when the task needs files on disk as well as search results. A query uses the same source selection and ranking as `retrieval search`. An explicit HTTP(S) URL starts from that URL directly.

```bash
unicli retrieval acquire "graph databases" \
  --sources dblp,arxiv \
  --limit 5 \
  --max-resources 10 \
  --dir ./research/graph-databases \
  -f json

unicli retrieval acquire \
  https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/ \
  --max-resources 0 \
  --dir ./research/cloudflare \
  -f json
```

The command streams each selected URL to a local original file. It uses the response MIME to structure downloaded text into an adjacent `<id>.document.json`, reusing the downloaded bytes. PDF, archive, image, and other binary responses retain their original bytes, including URLs without a filename extension. Text above the five-million-byte structuring limit retains the original file only.

For each selected result page, the command collects links whose filename or label identifies a downloadable resource. It deduplicates them, ranks them against the query, and downloads one bounded layer. Those downloaded links are terminal resources. Their own links do not start another crawl.

### Choose the collection size

`--limit` controls selected search results. `--max-resources` separately controls additional file links found on those pages. A direct URL has one initial resource. Setting `--max-resources 0` saves only the selected URLs.

| Option            | Default       | Accepted values and meaning                                       |
| ----------------- | ------------- | ----------------------------------------------------------------- |
| `--limit`         | `20`          | 1 to 100 selected search results                                  |
| `--max-resources` | `20`          | 0 to 100 additional file links across the selected pages          |
| `--concurrency`   | `3`           | 1 to 8 active resource downloads                                  |
| `--max-bytes`     | `52428800`    | 1 byte to 1 GiB per original file; the default is 50 MiB          |
| `--timeout-ms`    | `30000`       | 1 to 300000 milliseconds per resource download                    |
| `--dir`           | `./downloads` | Directory for originals, structured documents, and `results.json` |
| `--refresh`       | `false`       | Pass `true` to fetch completed resources again                    |

Search queries also accept `--sources`, `--kind`, `--source-class`, `--repository`, `--since`, and `--sort`. Use `unicli describe retrieval acquire --full -f json` for their complete contract. Source search and file download retain separate time limits.

### Inspect the saved result

The JSON envelope's `data[0]` contains the acquisition result. Read `data[0].manifest_path` for its absolute result-file path. `results.json` stores that acquisition object directly and is updated as resources finish.

- `candidates` retains selected search records and their source provenance.
- `resources` records each URL, originating `source_urls`, local `path`, byte `size`, and `status`.
- `document_path` identifies the structured companion when one was produced. `structure_error` reports a conversion failure. The original file remains available.
- `source_errors` records source-search failures independently of file-download results.
- `linked_resources_found` and `linked_resources_selected` show how the additional-resource limit affected selection. `selection_complete` records whether that selection finished. When an original page fails and capacity remains, it stays `false` so resume can fill the remaining slots from that page. Already selected linked resources remain terminal.

Read every resource status. `success` means a new original was published, `skipped` means a complete existing original was reused, and `failed` includes an error and retry command. An interrupted run records unfinished resources as `cancelled` after active workers settle. Completed files remain available.

### Resume the same collection

Use the returned absolute `manifest_path` to resume without repeating source discovery. Supply a query or `--resume`, one per invocation.

```bash
unicli retrieval acquire \
  --resume ./research/graph-databases/results.json \
  -f json

unicli retrieval acquire \
  --resume ./research/graph-databases/results.json \
  --refresh true \
  -f json
```

Resume restores the saved resource selection. It reuses an original when its recorded URL, path, successful state, and byte size match the local file. Failed, missing, or size-mismatched originals are fetched again. A recorded text-structuring failure also triggers a fresh download on resume. This reuse check compares file metadata; `--refresh true` explicitly requests current source bytes.

Each row's `retry_command` resumes the collection with its download size and timeout limits. It can therefore recover failures from more than one row in the same pass. The directory containing the resume file owns the output paths. Move the collection and its `results.json` together. A different directory produces new absolute paths, so resume fetches the resources again into that directory. A damaged or unsupported resume file produces `invalid_input` and remains unchanged.

Downloads use the same anonymous-first, domain-scoped credential recovery described below. `--no-auth-retry` disables automatic credential recovery for these requests. A remaining authentication or challenge failure is recorded for that resource, so the completed files and source errors remain available for the next decision.

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

OpenRouter search sends the query and page size to the server. Its public list and detail caches use 120-second and 300-second freshness bounds, further restricted by each response's cache policy. `--fresh true` bypasses the stored response. Shared GET caches separate request headers, including credentials and content negotiation, and publish atomically. Writes always execute through their request path.

When `dblp search` encounters an Anubis verification page, stderr retains `error.code = challenge_required`. Run the complete command in `error.alternatives[0]` to query the [official DBLP SPARQL service](https://blog.dblp.org/2024/09/09/introducing-our-public-sparql-query-service/). This explicit alternative matches the input as a case-insensitive literal phrase within publication titles, orders results by descending year and ascending record URI, and carries the original limit and offset. It uses its own matching semantics and runs only when selected. The `extract` response exposes records at `data.structured_data.results.bindings`. Pass the same URL to `retrieval acquire` to save the source JSON and a structured document.

An expired OpenReview credential produces an authentication failure. Follow the source's recovery instructions, then rerun the original query with the same pagination arguments.

## Recover with the source contract

| Response                                 | Agent action                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `challenge_required`                     | Use an available official API or a browser reader; credential-aware adapters follow their declared authentication flow |
| Authentication failure                   | Run `unicli auth setup <site>` and refresh the declared credential                                                     |
| HTTP 429 or a retryable upstream failure | Respect `Retry-After`; cancellation interrupts the wait                                                                |
| `invalid_content`                        | Inspect the expected MIME and API endpoint                                                                             |
| `operation_outcome_ambiguous`            | Read the current resource state before repeating an accepted write                                                     |

The HTTP reader recognizes `cf-mitigated: challenge` before parsing content. It also identifies HTML verification pages from their heading and challenge-specific content. Ordinary Turnstile documentation remains readable. Retry windows support seconds and HTTP dates. Failed response bodies are released before another attempt, and interrupted reads use the remaining attempt budget. If a write was accepted and its response is interrupted, inspect the resource state before repeating the write.

`extract` and `web read` start with an anonymous request. A 401, 403, or verification challenge can trigger a retry with domain-scoped saved cookies, followed by fresh cookies from the selected browser profile. The reader uses at most three authentication stages. Explicit third-party readers receive no source-site cookies. Read-only HTTP adapters that declare cookie authentication share a separate one-refresh retry in the execution runtime. Browser operations recover through a new browser turn. `--no-auth-retry` disables automatic credential recovery for both HTTP adapters and direct URL reads. See [Authentication](/guide/authentication) for profile selection, explicit imports, and `--no-auth-retry`.

[Cloudflare Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/) requires a recognized operator key and verified HTTP signatures. Admission remains a source-side decision. Use each source's supported API or authenticated browser flow when a challenge remains unresolved. Web Bot Auth enrollment and a general CAPTCHA solver are outside the implemented capability set.

## Compare the appropriate boundary

[Exa](https://exa.ai/docs/reference/search) exposes hosted web search with content extraction, domain filters, dates, and result limits. [Context7](https://context7.com/docs/api-guide) exposes documentation search with library selection, version hints, and snippet reranking. Uni-CLI routes local operations and composes registered sources with execution and recovery.

The [benchmark report](/BENCHMARK) compares local routing with BM25, TF-IDF, and MiniSearch on a shared catalog, and measures live native Markdown and OpenRouter response sizes separately. Hosted Exa and Context7 search quality requires its own shared query set, credentials, and relevance judgments. The local-routing result establishes performance within its measured catalog.
