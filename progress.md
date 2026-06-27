# Progress

## 2026-06-27 — Broad Corpus Source-Read Slice

- Root cause: OpenAlex, Semantic Scholar, and Unpaywall were already high-value
  broad corpus / OA / citation-discovery sources with metadata and PDF URL
  discovery, but their source contracts stopped at `scholar.pdf`; agents could
  find likely artifacts yet still had to leave the source surface to download
  and read text. That left an avoidable hallucination gap: metadata existence
  could be mistaken for source-grounded full-text access.
- Added source-scoped `read` commands for `openalex`, `semantic-scholar`, and
  `unpaywall`. Each command first resolves the source's own metadata row,
  requires a source-provided PDF URL, downloads that PDF, extracts bounded text
  with `pdftotext`, and returns `text_source=pdf`, `text_chars`, and
  `text_truncated`. Missing PDF URLs throw explicit adapter errors instead of
  inventing text.
- Reused the existing side-effect-free `readScholarPdf` helper rather than
  copying download/extraction logic or introducing a new factory abstraction.
  This keeps each source's fetch/auth/error semantics local while sharing the
  artifact validation, filename, page-range, truncation, and pdftotext
  contract.
- Upgraded the generated scholarly coverage contract: built `scholar coverage
--sources openalex,semantic-scholar,unpaywall` now reports all three as
  `has_fulltext=true` with `read_strategy=source-fulltext-then-pdf`.
- Experiment ladder:
  - Coverage observation before edit: built `scholar coverage` showed
    `openalex`, `semantic-scholar`, and `unpaywall` as `artifact-source`
    entries with `read_strategy=pdf-download`, `has_fulltext=false`, and
    recommended PDF/citation or OA roles but no source-fulltext surface.
  - Design check: considered a full artifact service, copied per-source
    `pdftotext` commands, and a bounded reuse of `readScholarPdf`. Chose the
    bounded reuse because it adds no new persistence target, keeps source
    provenance explicit, and avoids three divergent artifact pipelines.
  - Focused checks: `npm test --
tests/unit/adapters/scholar-sources.test.ts
tests/unit/adapters/scholar-artifacts.test.ts` exited 0 with 27 tests
    passed. `npm run typecheck`, `npm run lint`, `npm run lint:adapters`, and
    `npm run lint:schema-v2` all exited 0.
  - Build/dist checks: `npm run build` exited 0, updating generated stats to
    320 sites, 1,798 commands, 1,225 adapters, and 9,257 tests. Built
    `list --site openalex`, `list --site semantic-scholar`, and `list --site
unpaywall` all expose a `read` command. Built `describe openalex read`
    shows `download_file` operation policy with file-write, process-read,
    `pdftotext`, and output/filename resources.
  - Source discovery smokes: built `openalex search "large language models"
--limit 5` returned OpenAlex rows with real OA PDF URLs, including
    `W4323655724` from LMU. Built `semantic-scholar search "large language
models" --limit 5` returned a Semantic Scholar row
    `3f5b31c4f7350dc88002c121aecbdc82f86eb5bb` with
    `http://arxiv.org/pdf/2301.12597`.
  - Source read smokes: built `openalex read W4323655724 --first-page 1
--last-page 1 --max-chars 1000 --output
./.tmp/unicli-openalex-read-smoke` downloaded a 192,080-byte source PDF and
    extracted 5,492 page-1 characters before truncation. Built
    `semantic-scholar read 3f5b31c4f7350dc88002c121aecbdc82f86eb5bb
--first-page 1 --last-page 1 --max-chars 1000 --output
./.tmp/unicli-s2-read-smoke` downloaded a 6,737,540-byte arXiv PDF and
    extracted 8,266 page-1 characters before truncation.
  - Meta-route smokes: built `scholar read W4323655724 --source openalex ...`
    returned `command=openalex.read` and extracted PDF text. Built `scholar
read 3f5b31c4f7350dc88002c121aecbdc82f86eb5bb --source
semantic-scholar ...` returned `command=semantic-scholar.read` and
    extracted PDF text. Built `scholar read 10.1016/j.lindif.2023.102274
--source unpaywall ...` failed closed with `SCHOLAR_READ_NOT_FOUND` because
    `UNPAYWALL_EMAIL` is not configured and Unpaywall correctly returned
    `invalid_input`; no fake email or fabricated PDF path was used.
  - Full verification: `npm run verify` exited 0. Unit tests, adapter tests,
    perf gates, stats consistency, conformance, exports, changesets
    default-branch skip, and boundary guard all passed.
- Final closeout:
  - The first full verify after adding broad read commands exposed two contract
    drifts: Semantic Scholar loader parity still enumerated the pre-read command
    set, and broad `pdfIntent` boosting made Unpaywall outrank arXiv download
    for `download academic paper pdf`. Updated the loader parity contract and
    narrowed Unpaywall provider boost to DOI/OA intent, preserving Unpaywall
    discoverability for open-access lookup without stealing generic PDF
    download routing.
  - Old-code cleanup: removed the obsolete `src/adapters/cnki/search.yaml`
    path in favor of the TS adapter, verified no `cnki/search.yaml` references
    remain, and removed local smoke artifacts under `.tmp` and
    `arxiv-downloads` from the worktree before commit.
  - Third-party plugin audit: `tool_search` exposed the arXiv and Semantic
    Scholar MCP tools. Semantic Scholar MCP search returned current scholarly
    hits for `large language models`; a detail lookup with nested field syntax
    failed with HTTP 400, and arXiv citation graph hit a Semantic Scholar HTTP 429. The result supports the design choice that Uni-CLI must keep its own
    fail-closed multi-source loop instead of delegating correctness to one
    plugin.
  - Final coverage readback: built `scholar coverage` over 14 key sources shows
    arXiv, ACL Anthology, OpenReview, PubMed, bioRxiv, medRxiv, CVF, NeurIPS,
    PMLR, OpenAlex, Semantic Scholar, and Unpaywall as source-fulltext-capable;
    DBLP and HF remain explicit PDF/resource-discovery sources rather than
    false fulltext claims.
  - Final verification: `npm run verify` exited 0 after the closeout fixes.
    Unit tests: 241 files, 2,791 passed, 2 skipped. Adapter tests: 170 files,
    6,466 passed. Perf, compute snapshot coverage, adapter-test coverage,
    agent-size, stats consistency, conformance (942 passed, 42 quarantined, 0
    failed), exports, changesets default-branch skip, and boundary guard all
    passed.
- Residual risk: Unpaywall live full-text success still requires a real
  requester email via `--email` or `UNPAYWALL_EMAIL`; this environment only
  verified its missing-email fail-closed path. Semantic Scholar only supports
  read when Graph API returns `openAccessPdf.url`; papers without that field
  intentionally remain metadata/citation records rather than full-text claims.
  OpenAlex read depends on `primary_location` or `best_oa_location` PDF URLs,
  so closed or metadata-only works still fail explicitly.

## 2026-06-27 — Official Proceedings Source-Read Slice

- Root cause: CVF, NeurIPS, and PMLR were high-value official proceedings
  sources with search, metadata, and PDF URL coverage, but their coverage
  strategy was still `pdf-download`; agents could find papers but could not
  source-scope a direct text read from those official sites. A live CVF probe
  also exposed a separate transport defect: `curl` could fetch
  `https://openaccess.thecvf.com/ICCV2023?day=all` with HTTP 200 after about
  13-15 seconds, while Node's global fetch failed at the 10-second undici
  connect timeout.
- Added a side-effect-free PDF read helper at
  `src/adapters/scholar-artifacts/pdf-read.ts`. The helper owns URL/page/text
  validation, artifact filename derivation, guarded PDF download, `pdftotext`
  execution, truncation, and `text_source=pdf`, but registers no commands. This
  avoids importing a registering adapter from another adapter while keeping one
  shared extraction contract.
- Rebuilt `scholar-artifacts read-pdf` as a thin registration layer over the
  helper and normalized its public page/text options to
  `--first-page/--last-page/--max-chars`, matching arXiv/OpenReview/xRxiv/ACL
  read commands.
- Added `cvf read`, `neurips read`, and `pmlr read`. Each command resolves the
  source-local official paper page or metadata row, downloads the official PDF,
  extracts page-bounded text with `pdftotext`, declares `scholar.fulltext`,
  `scholar.pdf`, `http.download`, `subprocess.exec`, `executables:
["pdftotext"]`, and exposes source-scoped paths/domains in operation policy.
- Repaired CVF's slow official site fetch by using `undici.request` with the
  CVF HTML negotiation headers and a 30-second connect timeout, rather than
  falling back to shell `curl` or another source.
- Added `--venue`, `--year`, and `--volume` passthrough options to `scholar
read` and `scholar download`, and synchronized the static discovery contract
  in `src/discovery/core-catalog.ts`, so agents can discover and call
  source-scoped proceedings reads from the meta layer.
- Experiment ladder:
  - Reproduction before edit: built `scholar coverage` showed `cvf`,
    `neurips`, and `pmlr` as `read_strategy=pdf-download`,
    `has_fulltext=false`, missing `source-fulltext`. Initial dev `cvf search
"Segment Anything" --venue ICCV --year 2023` failed with
    `upstream_error: fetch failed`; direct Node fetch showed
    `UND_ERR_CONNECT_TIMEOUT`, while quoted `curl -L` fetched the official CVF
    page with HTTP 200 and about 5.7 MB of HTML.
  - Design check: considered a full artifact service, per-adapter copied
    `pdftotext`, and a shared side-effect-free helper. Chose the helper because
    it closes source-fulltext for three official sources without adding a
    persistence target or three divergent extraction implementations.
  - Focused checks: `npm test -- tests/unit/adapters/scholar-sources.test.ts
tests/unit/adapters/scholar-artifacts.test.ts tests/unit/commands/scholar.test.ts`;
    `npm run typecheck`; `npm run lint`; `npm run lint:adapters`;
    `npm run lint:schema-v2`.
  - Live source smokes: dev `cvf read
Kirillov_Segment_Anything_ICCV_2023_paper --venue ICCV --year 2023 ...`
    downloaded the official 10.9 MB CVF PDF and extracted 7,534 page-1
    characters. Dev `neurips read
0267925e3c276e79189251585b4100bf-Abstract-Conference --year 2024 ...`
    extracted 3,939 page-1 characters. Dev `pmlr read arora24a --volume 235
...` extracted 6,146 page-1 characters.
  - Meta-route smokes: dev `scholar read
Kirillov_Segment_Anything_ICCV_2023_paper --source cvf --venue ICCV
--year 2023 ...` returned `command=cvf.read` and extracted the official
    Segment Anything PDF text. Dev `scholar read ... --source neurips` and
    `scholar read arora24a --source pmlr` both returned their source-specific
    `read` commands and extracted PDF text.
  - Build/dist smokes: `npm run build` exited 0, updating stats to 320 sites,
    1,795 commands, and 9,257 tests. Built `scholar coverage --sources
cvf,neurips,pmlr` reports `has_fulltext=true`,
    `read_strategy=source-fulltext-then-pdf`, and `next_fulltext` for each
    source. Built `describe cvf read` and `describe scholar read` expose
    `pdftotext`, source output paths, and source-scope options. Built `scholar
read ... --source cvf --venue ICCV --year 2023`, built `neurips read ...`,
    and built `pmlr read ...` all downloaded official PDFs and extracted text.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2,791
    passed, 2 skipped. Adapter tests: 170 files, 6,466 passed. Perf,
    compute-snapshot coverage at 100%, adapter-test coverage, agent-size,
    stats consistency, conformance (942 passed, 42 quarantined, 0 failed),
    exports, changesets default-branch skip, and boundary guard all passed.
- Residual risk: these three official proceedings sources still lack
  code/project, dataset/model/space, citation/reference graph, and peer-review
  coverage. Search remains source-local to explicit event/year/volume pages;
  broader cross-year proceedings search still requires meta discovery or
  source-specific iteration.

## 2026-06-27 — ACL Anthology Metadata Search and Source Read Slice

- Root cause: ACL Anthology coverage advertised search/PDF support, but the
  live `/search/?q=...` page now serves only a Google Custom Search client-side
  placeholder, so server-side HTML parsing returned no paper rows. ACL also had
  no source-scoped `scholar.fulltext` command, so `scholar read --source
acl-anthology` could only rely on generic PDF fallback. Finally,
  source-scoped `scholar read` tried availability canonicalization before
  direct full-text commands, making source-local IDs slower than necessary.
- Rebuilt `acl-anthology search` on the official
  `https://aclanthology.org/anthology.bib.gz` metadata export instead of the
  Google CSE HTML placeholder. The adapter now parses BibTeX rows into
  normalized scholarly records with ACL IDs, titles, authors, year, venue, DOI,
  source URL, and official PDF URL, then ranks title/author/id/year matches
  locally.
- Added `acl-anthology read`: it resolves a source-local ACL Anthology ID or
  URL, fetches the official paper page for metadata, downloads the official PDF,
  extracts page-bounded text with `pdftotext`, labels `text_source=pdf`, and
  exposes `scholar.fulltext` plus `executables: ["pdftotext"]` for accurate
  command governance.
- Optimized `scholar read` routing so source-scoped reads try source-direct
  full text against the caller's original ref before doing canonical lookup.
  Title/fuzzy inputs still fall back to availability canonicalization, but
  explicit source IDs such as `2020.acl-main.447 --source acl-anthology` now
  take the direct path.
- Experiment ladder:
  - Reproduction before edit: built `acl-anthology search BERT --limit 3`
    returned `No ACL Anthology papers matched "BERT"`, while direct fetch of
    `https://aclanthology.org/search/?q=BERT` showed only the Google CSE
    placeholder. `anthology.bib.gz` returned HTTP 200, about 11.5 MB gzip, with
    a same-day generated timestamp.
  - Focused checks: `npm run test:adapter --
src/adapters/acl-anthology/papers.test.ts`; `npx vitest run
tests/unit/adapters/scholar-artifacts.test.ts
tests/unit/adapters/scholar-sources.test.ts`; `npm test --
tests/unit/commands/scholar.test.ts`; `npm run typecheck`; `npm run lint`;
    `npm run lint:adapters`; `npm run lint:schema-v2`.
  - Live source smokes: dev `acl-anthology search BERT --limit 3` returned
    official BibTeX-derived ACL records, headed by `2026.propor-1.91`. Dev
    `acl-anthology read 2020.acl-main.447 --first-page 1 --last-page 1
--max-chars 2000 --output ./.tmp/unicli-acl-read-smoke` downloaded the
    official S2ORC PDF and extracted 4,896 page-1 characters. Dev `scholar read
2020.acl-main.447 --source acl-anthology ...` returned `command:
acl-anthology.read` in about 4.9 seconds after the direct-read routing
    change.
  - Build/dist smokes: `npm run build` exited 0, updating stats to 320 sites,
    1,792 commands, and 9,256 tests. Built `acl-anthology search BERT --limit
2` returned two official metadata rows. Built `scholar coverage --sources
acl-anthology` reports `has_fulltext=true`,
    `read_strategy=source-fulltext-then-pdf`, `next_fulltext=unicli
acl-anthology read <id-or-ref>`, and coverage `4/11`. Built `scholar read
2020.acl-main.447 --source acl-anthology ...` returned
    `acl-anthology.read`, extracted 4,896 characters, and took about 6.7 seconds
    end to end.
- Residual risk: ACL search now uses the official metadata export and not the
  Google CSE ranking/search-in-PDF surface, so it searches metadata rather than
  full PDF text. ACL still lacks code/project, dataset/model, citation/reference
  graph, and peer-review coverage.

## 2026-06-27 — xRxiv Official Date-Window Search Slice

- Root cause: bioRxiv and medRxiv exposed DOI metadata, recent browsing, PDF
  download, and source-fulltext reading, but not query discovery. The official
  `api.biorxiv.org/details` documentation exposes DOI/date/recent/category
  endpoints, not a keyword full-corpus search endpoint; bioRxiv's website
  search also returned HTTP 403 on direct fetch, while medRxiv's HTML search was
  readable but not a source-stable metadata API. Treating either path as a
  universal full-history search would have hidden the actual source boundary.
- Added one shared xRxiv `search` implementation that uses the official details
  API only. It scans a bounded date window, defaults to the last seven UTC days,
  filters title/abstract/authors/DOI/category, fails closed on empty matches,
  and annotates each row with `matched_fields`, `search_scope`,
  `search_window`, `search_scanned_records`, `search_total_records`, and
  `search_exhaustive`. bioRxiv and medRxiv now both register `search` with
  `scholar.search` while reusing shared xRxiv columns/args/capabilities instead
  of duplicating declarations.
- Fixed a generated-manifest regression exposed by this refactor. The TS
  manifest scanner now resolves relative named-import array constants and array
  spread elements, so shared adapter arg/column/capability declarations still
  produce correct `describe` schemas. `scholar` record normalization now
  preserves search provenance fields, so meta-search results keep the bounded
  source scope visible to agents.
- Experiment ladder:
  - Source observation: `node dist/main.js -f json list --site biorxiv` showed
    no query command before the slice. The official API root documented
    `details/[server]/[interval]/[cursor]/[format]`,
    `details/[server]/[DOI]/na/[format]`, category filters, and published/funder
    endpoints, but no keyword endpoint. Live `biorxiv recent --from 2026-06-20
--to 2026-06-27 --limit 2` returned official metadata. Direct bioRxiv website
    search returned HTTP 403; medRxiv website search returned HTML, confirming
    that website search should not be the default source of paper facts.
  - Focused checks: `npm run test:adapter -- src/adapters/rxiv/preprints.test.ts`
    exited 0 with 6 passed; `npm test -- tests/unit/manifest-ts-scan.test.ts`
    exited 0 with 6 passed; `npm test -- tests/unit/commands/scholar.test.ts`
    exited 0 with 44 passed.
  - Static checks: `npm run typecheck`, `npm run lint`, `npm run lint:adapters`,
    and `npm run format:check` exited 0.
  - Live source smokes: dev and built `biorxiv search recount3 --from
2026-06-20 --to 2026-06-20 --max-pages 1 --limit 2` returned the official
    bioRxiv record `10.64898/2026.06.17.732943` with provenance fields. Dev
    `medrxiv search "artificial intelligence" --from 2026-06-20 --to
2026-06-27 --max-pages 3 --limit 2` returned two current medRxiv records
    from official metadata.
  - Build/dist smokes: `npm run build` exited 0 and updated stats to 320 sites,
    1790 commands, and 9247 tests. Built `describe biorxiv search` and
    `describe medrxiv search` both expose `query`, `from`, `to`, `cursor`,
    `limit`, `max-pages`, and `category`. Built `scholar search recount3
--sources biorxiv --limit 2` now returns the record and preserves
    `search_scope=official_api_date_window`, `search_window=2026-06-20:2026-06-27`,
    scanned/total counts, and `search_exhaustive=false`.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2789
    passed, 2 skipped. Adapter tests: 169 files, 6458 passed. Perf, compute
    snapshot coverage at 100%, adapter-test coverage, agent-size, stats
    consistency, conformance (942 passed, 42 quarantined, 0 failed), exports,
    changesets default-branch skip, and boundary guard all passed.
- Residual risk: this is intentionally not a full-history keyword search for
  xRxiv. It is a truthful official-API date-window search with explicit
  provenance. Historical or broader searches require explicit `--from/--to` and
  `--max-pages`, or a separate cross-corpus discovery source such as OpenAlex,
  followed by xRxiv DOI lookup/read/download for source-backed facts.

## 2026-06-27 — CNKI KNS Criteria Search Repair Slice

- Root cause: `cnki search "人工智能"` still targeted the removed
  `https://scholar.cnki.net/api/search` endpoint, so the direct command and
  `scholar doctor --sources cnki --live` failed with HTTP 404 even though the
  current CNKI Scholar app was reachable. Bundle tracing showed the live result
  page now posts signed JSON queries to
  `https://scholar.cnki.net/restapi/kns8s-api/v2/criteria/query` with an AES
  `vv` token, fixed `clientId`, and the current all-database class id
  `WD0FTY92`.
- Replaced the stale YAML adapter with one TypeScript adapter as the single
  source of truth. The adapter now builds CNKI's current title fuzzy-search
  payload, generates the public app-compatible `vv` token, fails closed on
  non-zero CNKI API codes, and maps KNS metadata/relations into normalized
  scholarly rows with source-local `id`, stripped title HTML, authors, date,
  year, venue, type, abstract, DOI, citation count, `source_url`, and CNKI PDF
  relation hints. It does not advertise `scholar.pdf`, because CNKI's PDF
  relation is an official order/download URL that may still require access.
- Experiment ladder:
  - Reproduction before edit: dev `cnki search "人工智能"` exited 1 with
    `not_found` / HTTP 404 from the stale `/api/search` URL. Dev `scholar
doctor --sources cnki --live --query "人工智能" -D` reported
    `live_health=failed`. `unicli repair cnki search` was unavailable because
    the worktree was intentionally dirty, so the repair proceeded manually.
  - Source observation: after Uni-CLI routing, fetched the current
    `scholar.cnki.net` app bundle, traced `/restapi/kns8s-api/v2/criteria/query`
    and the `cf4e8f...` AES token helper, queried
    `/v2/resources/released`, and verified `WD0FTY92` as the live all-database
    class id. A direct Node replay of `TI/FUZZY` query `人工智能` returned live
    CNKI rows with DOI, abstract, authors, and `ABSTRACT` / `PDF` relations.
  - Focused checks: `npx prettier --write src/adapters/cnki/search.ts
tests/unit/adapters/scholar-sources.test.ts` exited 0; focused `npm test --
tests/unit/adapters/scholar-sources.test.ts` exited 0 with 21 passed;
    `npm run typecheck`, `npm run lint`, and `npm run lint:adapters` exited 0.
  - Live source smokes: dev `cnki search "人工智能" --limit 3` returned three
    current CNKI rows; dev `scholar search "人工智能" --sources cnki --limit 3`
    returned normalized scholar rows; dev `scholar doctor --sources cnki --live
--query "人工智能" -D` returned `live_health=passed`; dev intent search for
    `cnki academic paper search` ranked `cnki search` first with the updated
    description.
  - Build/dist smoke: `npm run build` exited 0; built `node dist/main.js -f
json describe cnki search` reported adapter path
    `src/adapters/cnki/search.ts`; built `node dist/main.js -f json cnki
search "人工智能" --limit 2` returned live rows; built `node dist/main.js -f
json scholar doctor --sources cnki --live --query "人工智能" -D` returned
    `live_health=passed`.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2787
    passed, 2 skipped. Adapter tests: 169 files, 6456 passed. Perf, compute
    coverage, adapter-test coverage (74 covered adapters), agent-size, stats
    consistency, conformance (942 passed, 42 quarantined, 0 failed), exports,
    changesets default-branch skip, and boundary guard all passed.
- Residual risk: this repairs CNKI as a current direct and meta-search
  discovery source on the public Scholar KNS path. It does not bypass CNKI
  subscription, login, captcha, or payment boundaries, and it treats PDF
  relation URLs as availability hints rather than guaranteed unauthenticated
  artifacts.

## 2026-06-27 — DBLP Scholar Normalization Repair Slice

- Root cause: `dblp search "Llama 2"` returned live DBLP rows, but those rows
  used DBLP's source-local `key` without mirroring it into the normalized
  scholarly `id` field. `coerceToScholarlyRecords` correctly rejects records
  without `id + title`, so `scholar search --sources dblp` exited
  `SCHOLAR_NOT_FOUND`, and `scholar doctor --sources dblp --live` reported
  `empty_normalized_result` despite DBLP being reachable and returning data.
- Repaired DBLP at the adapter boundary. Publication search, paper XML mapping,
  and author publication projection now expose `id`, `dblp_key`, `source_url`,
  and `landing_url` while keeping DOI as a separate cross-source dedupe field.
  This keeps DBLP source identity explicit instead of adding a global
  `key`-to-`id` fallback that would admit ambiguous rows from unrelated
  adapters.
- Experiment ladder:
  - Reproduction before edit: dev `dblp search "Llama 2" --limit 3` returned
    three DBLP rows, but dev `scholar search "Llama 2" --sources dblp --limit 3
-D` exited 66 with `SCHOLAR_NOT_FOUND`; dev `scholar doctor --sources dblp
--live --query "Llama 2" -D` returned `live_health=empty` /
    `empty_normalized_result`.
  - Focused checks: `npx prettier --write src/adapters/dblp/publications.ts
src/adapters/dblp/publications.test.ts` exited 0; `npm run typecheck` exited
    0; correct adapter project probe `npx vitest run --project adapter
src/adapters/dblp/publications.test.ts --reporter=dot` exited 0 with 4 passed;
    `npm run lint` exited 0.
  - Live source smokes: dev `dblp search "Llama 2" --limit 3` returned rows
    with `id`, `dblp_key`, DOI `source_url`, and DBLP `landing_url`. Dev
    `scholar search "Llama 2" --sources dblp --limit 3 -D` returned three
    scholar-normalized records with array authors, numeric years, DOI, DBLP
    key, and landing URL. Dev `scholar doctor --sources dblp --live --query
"Llama 2" -D` returned `live_health=passed`.
  - Source-local record smoke: dev `dblp paper journals/es/KumarRCDS25`
    returned the normalized DBLP identity fields, and dev `scholar sources
journals/es/KumarRCDS25 --sources dblp -D` resolved the record into canonical
    DOI `10.1111/exsy.13760` with `source_status=evidence_found`.
  - Build/dist smoke: `npm run build` exited 0; built `node dist/main.js -f
json dblp search "Llama 2" --limit 3`, built `node dist/main.js -f json
scholar search "Llama 2" --sources dblp --limit 3 -D`, and built `node
dist/main.js -f json scholar doctor --sources dblp --live --query "Llama 2"
-D` all exited 0, with built doctor returning `live_health=passed`.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2784
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this repairs DBLP as a truthful CS bibliography source for
  direct search, meta-search, doctor, and source-local record handoff. It does
  not claim every DBLP `ee` URL is an open PDF; PDF/full-text evidence still
  requires downstream artifact checks or source-specific reading commands.

## 2026-06-27 — Google Scholar Normalization and Year-Parsing Repair Slice

- Root cause: `google-scholar search` could return live browser rows for
  queries such as `Llama 2`, but those rows lacked the normalized `id` field
  required by `scholar` meta-command coercion. As a result, direct Google
  Scholar search returned real papers while `scholar search --sources
google-scholar` returned `SCHOLAR_NOT_FOUND`, and `scholar doctor --live`
  reported `empty_normalized_result`. The same adapter also extracted
  publication years with an unbounded `(19|20)\d{2}` regex, so arXiv ids such
  as `2310.20624` could produce hallucinated years such as `2062`.
- Rebuilt the Google Scholar browser adapter boundary so DOM extraction returns
  raw result facts and TypeScript-owned mapping adds source-stable ids, venue,
  numeric year, numeric `cited_by_count`, `source_url`, and arXiv/DOI-derived
  record identity. The adapter now detects Google Scholar CAPTCHA / unusual
  traffic / `/sorry/` pages and fails closed with `upstream_blocked` instead of
  treating an upstream block as an empty scholarly result.
- Experiment ladder:
  - Reproduction before edit: dev `google-scholar search "Llama 2" --limit 3`
    returned three live rows, including `Llama 2: Open foundation and
    fine-tuned chat models`, but dev `scholar search "Llama 2" --sources
google-scholar --limit 3 -D` exited 66 with `SCHOLAR_NOT_FOUND`; dev
    `scholar doctor --sources google-scholar --live --query "Llama 2" -D`
    returned `live_health=empty` / `empty_normalized_result`.
  - Focused checks: `npx prettier --write
src/adapters/google-scholar/search.ts
tests/unit/adapters/scholar-sources.test.ts` exited 0; focused `npm test --
tests/unit/adapters/scholar-sources.test.ts` exited 0 with 18 passed; `npm run
typecheck` and `npm run lint` exited 0.
  - Live source smokes: dev `google-scholar search "Llama 2" --limit 3`
    returned ids `2307.09288`, an IEEE source URL, and `2310.20624`, with
    numeric years and citation counts. Dev `scholar search "Llama 2" --sources
google-scholar --limit 3 -D` returned three scholar-normalized records, and dev
    `scholar doctor --sources google-scholar --live --query "Llama 2" -D`
    returned `live_health=passed`.
  - Build/dist smoke: `npm run build` exited 0; built `node dist/main.js -f
json google-scholar search "Llama 2" --limit 3`, built `node dist/main.js -f
json scholar search "Llama 2" --sources google-scholar --limit 3 -D`, and built
    `node dist/main.js -f json scholar doctor --sources google-scholar --live
--query "Llama 2" -D` all exited 0, with built doctor returning
    `live_health=passed`.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2784
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this repairs Google Scholar as a truthful broad discovery
  source for direct command, meta-search, and doctor health on the current
  network path. It does not make Google Scholar an artifact/full-text source,
  does not bypass CAPTCHA or rate limits, and does not repair CNKI's current
  upstream 404.

## 2026-06-27 — Baidu Scholar Live Discovery Repair Slice

- Root cause: Baidu Scholar no longer serves the adapter's old
  `https://xueshu.baidu.com/s?wd=...` result shape. The public browser flow now
  lands on `/ndscholar/browse/search?wd=...`, and result cards render as
  `.paper-wrap.result` with `.paper-title`, `.paper-info`, `.paper-abstract`,
  `.paper-source`, source-local `paperid`, citation count, year, type, and
  provider links. The old route triggered `Navigation failed: net::ERR_ABORTED`
  before DOM extraction, so `scholar doctor --live` marked Baidu Scholar as
  failed even though the public search page was reachable.
- Rebuilt `baidu-scholar search` against the current Baidu Scholar route and DOM
  while keeping the source discovery-only. The adapter now returns source-local
  ids, title, authors, venue/source, type, year, abstract, cited count,
  source_url, and provider `source_links`; those provider links remain discovery
  hints and are not advertised as PDF/full-text evidence.
- Experiment ladder:
  - Reproduction before edit: dev `scholar doctor --sources
cnki,baidu-scholar,google-scholar --live --query "人工智能" -D` returned
    Baidu Scholar `live_health=failed` / `Navigation failed:
net::ERR_ABORTED`; browser inspection of
    `https://xueshu.baidu.com/ndscholar/browse/search?wd=人工智能` showed live
    result cards headed by `不确定性人工智能`.
  - Focused checks: `npx prettier --write
src/adapters/baidu-scholar/search.ts
tests/unit/adapters/scholar-sources.test.ts` exited 0; `npm run typecheck`
    exited 0; focused `npx vitest run --project unit
tests/unit/adapters/scholar-sources.test.ts --maxWorkers=1 --reporter=dot`
    exited 0 with 15 passed.
  - Live source smokes: dev `baidu-scholar search "人工智能" --limit 3` returned
    three Baidu Scholar rows with `paperid`, authors, source/venue, year,
    abstract, `cited_by_count`, `source_url`, and provider links. Dev
    `scholar doctor --sources baidu-scholar --live --query "人工智能" -D`
    returned `live_health=passed`; dev `scholar search "人工智能" --sources
baidu-scholar --limit 3 -D` returned scholar-normalized records with array
    authors, numeric year, and numeric cited counts.
  - Build/dist smoke: `npm run build` exited 0; built `node dist/main.js -f
json baidu-scholar search "人工智能" --limit 2` returned Baidu Scholar rows;
    built `node dist/main.js -f json scholar search "人工智能" --sources
baidu-scholar --limit 2 -D` returned normalized rows; built
    `node dist/main.js -f json scholar doctor --sources baidu-scholar --live
--query "人工智能" -D` returned `live_health=passed` when run sequentially.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2781
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this repairs Baidu Scholar as a live discovery source and
  improves Chinese academic source comparison. It does not make Baidu provider
  links artifact-proof, does not repair CNKI's upstream 404, and does not make
  Google Scholar produce normalized rows on the current network path.

## 2026-06-27 — CVF Artifact Source Live Repair and Doctor Classification Slice

- Root cause: CVF OpenAccess uses Apache content negotiation on proceedings
  pages such as `https://openaccess.thecvf.com/CVPR2024?day=all`. Curl and
  browser-shaped requests returned the 7.4 MB proceedings HTML, but Node
  `fetch` with the adapter's narrow `Accept: text/html` header returned HTTP
  406 because the negotiated `proceedings.py` representation was not acceptable
  to that header. This made a real artifact source look dead in live doctor.
- Repaired the CVF adapter at the request boundary by using a broad HTML accept
  header (`text/html, application/xhtml+xml, application/xml, */*`) while
  keeping the public CVF URL and normal source parser. The fix preserves
  fail-closed upstream errors instead of swallowing HTTP failures or falling
  back to another source.
- Fixed `scholar doctor --live` classification for normal no-match adapter
  results. Source-local messages of the form `No ... matched "<query>"` now
  report `live_health=empty` / `empty_source_result` rather than `failed`, while
  true HTTP, navigation, auth, and upstream failures remain `failed`. This makes
  cross-site live comparison less misleading for venue-specific sources such as
  ACL, CVF, and NeurIPS when the global probe query is outside that venue.
- Experiment ladder:
  - Reproduction before edit: dev `cvf search "Llama 2" --limit 3` exited 1
    with `upstream_error` / `CVF CVPR2024 failed: HTTP 406`; direct Node fetch
    with `Accept: text/html` reproduced 406, while Node fetch with broad HTML
    accept returned 200 OK and the proceedings HTML.
  - Focused checks: `npx prettier --write src/adapters/cvf/papers.ts
tests/unit/adapters/scholar-sources.test.ts src/commands/scholar.ts
tests/unit/commands/scholar.test.ts` exited 0; `npm run typecheck` exited
    0; focused `npx vitest run --project unit tests/unit/commands/scholar.test.ts
tests/unit/adapters/scholar-sources.test.ts --maxWorkers=1 --reporter=dot`
    exited 0 with 57 passed.
  - Live source smokes: dev `cvf search "segmentation" --limit 3` returned
    current CVPR 2024 paper rows with `pdf_url` and `source_url`; dev
    `scholar doctor --sources cvf --live --query "segmentation" -D` returned
    `live_health=passed`; dev `scholar doctor --sources cvf --live --query
"Llama 2" -D` returned `live_health=empty` instead of `failed`; dev
    `scholar doctor --sources acl-anthology,neurips,cvf --live --query "Llama
2" -D` classified all three venue no-match results as `empty`.
  - Artifact smokes: dev `scholar read
Lee_Guided_Slot_Attention_for_Unsupervised_Video_Object_Segmentation_CVPR_2024_paper
--source cvf --first-page 1 --last-page 1 --max-chars 1000` downloaded the
    CVF PDF and extracted first-page text. Dev `scholar download` for the same
    CVF id wrote the PDF to `/tmp/unicli-cvf-download-smoke` with a 4,709,073
    byte artifact.
  - Build/dist smoke: `npm run build` exited 0; built `node dist/main.js -f
json cvf search "segmentation" --limit 2` returned CVPR rows; built
    `node dist/main.js -f json scholar doctor --sources cvf --live --query
"Llama 2" -D` returned `empty_source_result`; built `node dist/main.js -f
json scholar read <cvf-id> --source cvf --output
/tmp/unicli-cvf-read-dist-smoke --first-page 1 --last-page 1 --max-chars
1000` extracted capped PDF text.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2780
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this closes the CVF OpenAccess search/read/download live
  artifact path for the default CVPR 2024 venue/year and makes live doctor more
  truthful for no-match probes. It does not make CNKI, Baidu Scholar, or Google
  Scholar healthy, and CVF remains bounded by explicit `--venue/--year` rather
  than a full historical all-venue search index.

## 2026-06-27 — Wanfang Live Scholarly Extraction Repair Slice

- Root cause: the Wanfang adapter still used stale generic result selectors
  (`.normal-list .item`, `.result-list .item`, anchors under title nodes). The
  current public Wanfang paper search page is an SPA that renders paper cards as
  `.normal-list` blocks with `.title-area .title`, a hidden
  `.title-id-hidden` such as `periodical_cjlc202602007`, author/source metadata
  under `.author-area`, and no ordinary detail anchor in the card. The adapter
  therefore navigated successfully but returned zero normalized rows.
- Rebuilt the Wanfang extraction against the observed live DOM. It now extracts
  title, authors, venue/source, type, year, abstract, cited count, and synthesizes
  stable Wanfang detail URLs from the hidden id (`periodical_xxx` ->
  `https://d.wanfangdata.com.cn/periodical/xxx`). The command remains
  discovery-only and does not claim PDF, full-text, citation, review, code, or
  dataset evidence.
- Experiment ladder:
  - Reproduction before edit: dev `scholar doctor --sources cnki,wanfang --live
--query "人工智能" -D` returned Wanfang `live_health=empty` and CNKI
    `live_health=failed` / `not_found`. Browser inspection of
    `https://s.wanfangdata.com.cn/paper?q=人工智能` showed live results headed by
    `人工智能与企业投资效率提升` with hidden id
    `periodical_cjlc202602007`.
  - Focused checks: `npx prettier --write src/adapters/wanfang/search.ts`
    exited 0 unchanged; `npm run typecheck` exited 0; focused
    `npx vitest run --project unit tests/unit/commands/scholar.test.ts
tests/unit/adapters/scholar-sources.test.ts --maxWorkers=1 --reporter=dot`
    exited 0 with 55 passed.
  - Live source smokes: dev `wanfang search "人工智能" --limit 3` returned three
    current 2026 Wanfang paper rows with synthesized `source_url`; dev
    `scholar doctor --sources wanfang --live --query "人工智能" -D` returned
    `live_health=passed`; dev `scholar search "人工智能" --sources wanfang --limit
3 -D` returned three scholar-normalized rows with array authors, numeric
    year, and numeric cited counts where present.
  - Build/dist smoke: `npm run build` exited 0; built
    `node dist/main.js -f json wanfang search "人工智能" --limit 3` returned the
    same three Wanfang rows; built `node dist/main.js -f json scholar doctor
--sources wanfang --live --query "人工智能" -D` returned
    `live_health=passed`.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2778
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this repairs Wanfang live discovery and the scholar-layer
  Agent handoff, but Wanfang remains discovery-only until separate artifact
  adapters prove PDF/full-text access. CNKI is still a separate upstream 404
  finding, not repaired by this slice. Wanfang DOM drift can still break
  extraction, but that failure is now caught by `scholar doctor --live` instead
  of being hidden behind static capability introspection.

## 2026-06-27 — Scholarly Coverage Completeness and Live Doctor Slice

- Root cause: `list --category scholarly` exposed 23 scholarly-category sites,
  but `scholar coverage --sources all -D` and `scholar doctor` only saw 19
  capability-tagged sources. The missing resource-relevant sites were `cnki`
  and `wanfang`; `scholar`, `scholar-artifacts`, and `paperreview` are meta,
  artifact plumbing, or submission/review services and should not be counted as
  source-backed literature providers. Static `doctor` also risked misleading
  Agents by reporting sources as capability-introspected even when a live search
  currently fails.
- Added `scholar.search` capability and scholar-normalized discovery fields to
  CNKI and Wanfang search adapters. They now enter the coverage matrix as
  discovery-only sources with canonical handoff commands, not as metadata/PDF
  evidence providers.
- Added opt-in live probing to `scholar doctor`. Default doctor remains
  zero-network capability introspection; `--live --query <query>` now executes
  each selected source's queryable `scholar.search` command through the normal
  scholar normalization seam and reports `passed`, `empty`, `failed`,
  `blocked`, or `not_probeable` with structured error fields.
- This makes coverage broader without pretending broken live surfaces are
  healthy. In current live probes, CNKI is included in coverage but reports
  `live_health=failed` with the upstream 404 endpoint; Wanfang is included but
  reports `live_health=empty` because the browser extraction currently returns
  no scholar-normalized rows.
- Experiment ladder:
  - Reproduction before edit: dev `list --category scholarly` returned 23
    sites while dev `scholar coverage --sources all --gaps -D` returned 19
    sources. The missing non-meta literature sources were `cnki` and `wanfang`.
    Direct dev `cnki search "Llama 2" --limit 3` exited 1 with HTTP 404 from
    `https://scholar.cnki.net/api/search`; direct dev `wanfang search
"人工智能" --limit 3` exited 0 with zero rows.
  - Design choice: high-investment per-site health commands would add bespoke
    machinery; the shortest path would keep static capability introspection.
    Chosen bounded design: an opt-in live doctor that reuses existing
    queryable search commands and structured adapter errors.
  - Focused checks: `npm run typecheck` exited 0;
    `npx vitest run --project unit tests/unit/commands/scholar.test.ts
--maxWorkers=1 --reporter=dot` exited 0 with 42 passed; `npm run lint` exited 0.
  - Live source smokes: dev `scholar coverage --sources cnki,wanfang -D`
    returned two discovery-only rows with `next_search`, `next_workflow_from_result`,
    `next_sources_from_result`, and `next_read_from_result`; dev
    `scholar doctor --sources cnki,wanfang -D` remained static and zero-network;
    dev `scholar doctor --sources cnki,wanfang --live --query "人工智能" -D`
    returned CNKI `live_health=failed` / `not_found` and Wanfang
    `live_health=empty`; dev `scholar doctor --sources arxiv --live --query
"Llama 2" -D` returned `live_health=passed`.
  - Build/dist smoke: `npm run build` exited 0; built `node dist/main.js`
    smokes matched dev behavior for CNKI/Wanfang coverage and live doctor. A
    built catalog comparison showed 23 scholarly-category sites, 21 coverage
    sources, no missing non-meta scholarly sites, and both CNKI and Wanfang
    covered.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2778
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this closes the static coverage gap for real scholarly
  discovery sources and gives Agents a current live-health check. It does not
  repair CNKI's upstream 404 endpoint or Wanfang's currently empty browser
  extraction; those are now explicit live doctor findings instead of hidden
  capability drift.

## 2026-06-27 — Scholarly Resource Search Canonical Guard Slice

- Root cause: `scholar.code` and `scholar.datasets` used capability selection
  that could fall back from a known paper ref to the first resource-capable
  command on a source. For `huggingface-papers`, that meant a no-arg daily/list
  command could be treated as single-paper resource evidence, so an Agent asking
  for `2307.09288` could see unrelated daily rows such as ABACUS instead of the
  Llama 2 paper. The first repair made this too strict: explicit
  `--source huggingface-papers` stopped using daily/list rows, but also failed
  before using the source's queryable `search` command for exact arXiv-id
  resource lookup.
- Split resource command routing into two evidence-safe paths. Known refs now
  try only true single-record resource commands first, then queryable
  resource-search commands, and accept search candidates only when their
  identifier fields match the requested arXiv/DOI/PMID/OpenReview ref. Unknown
  title searches still use title relevance before any detail enrichment.
- Tightened coverage and source-audit runbooks. Resource-capable list commands
  are no longer exposed as `next_code` or `next_datasets` paper lookups.
  `huggingface-papers` now advertises
  `unicli huggingface-papers search <id-or-ref>` instead of the invalid
  `daily <id-or-ref>` command shape.
- Cleaned failure diagnostics for resource fallbacks. If a queryable search
  succeeds for a source, a missing single-record resource command is no longer
  reported as the primary error; empty dataset/model results now stay a clean
  no-resource outcome rather than an unsupported-capability false lead.
- Experiment ladder:
  - Reproduction before edit:
    `npm run --silent dev -- -f json scholar code 2307.09288 --source
huggingface-papers -D` returned 15 daily rows headed by ABACUS, while direct
    `npm run --silent dev -- -f json huggingface-papers daily 2307.09288`
    exited with `too many arguments for 'daily'`. Direct
    `huggingface-papers search 2307.09288` returned the Llama 2 row with
    `code_url=https://github.com/facebookresearch/llama`.
  - Focused checks: `npm run typecheck` exited 0;
    `npx vitest run --project unit tests/unit/commands/scholar.test.ts
--maxWorkers=1 --reporter=dot` exited 0 with 41 passed; `npm run lint` exited 0.
  - Live source smokes: dev `scholar code 2307.09288 --source
huggingface-papers -D` now returns one Llama 2 row with
    `code_url=https://github.com/facebookresearch/llama`; dev
    `scholar availability 2307.09288 --source huggingface-papers -D` includes
    the same code evidence and `canonical_ref=2307.09288`; dev
    `scholar coverage --sources huggingface-papers -D` emits
    `next_code`/`next_datasets` as `unicli huggingface-papers search
<id-or-ref>`; dev `scholar datasets 2307.09288 --source huggingface-papers -D`
    exits 66 with a clean `SCHOLAR_RESOURCE_NOT_FOUND` and no unrelated rows.
    All live smokes were checked for absence of `ABACUS` and `2606.` rows.
  - Build/dist smoke: `npm run build` exited 0; built `node dist/main.js`
    smokes for `scholar code`, `scholar coverage`, and `scholar datasets` on
    the same ref/source matched the dev behavior.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2777
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this closes the known-ref resource contamination boundary for
  Hugging Face Papers and capability-equivalent scholarly sources. It does not
  guarantee that every external source exposes code/dataset fields for every
  paper, and it does not add new dataset evidence for Llama 2 where the source
  does not provide it.

## 2026-06-27 — Scholarly Canonicalized Availability Slice

- Root cause: the previous workflow retry fixed only `scholar workflow`.
  Neighboring Agent-facing commands still used the first availability pass:
  `scholar sources "Llama 2" --sources baidu-scholar,zotero,arxiv -D`
  returned per-source rows with no canonical ref and dead
  `next_source_availability 'Llama 2'` commands, while `scholar evidence` and
  `scholar reproduce` with the same source set exited 66 after arXiv received
  `id_list=Llama%202`.
- Promoted the retry into shared canonicalized availability for
  `availability`, `sources`, `workflow`, `evidence`, and `reproduce`. For an
  unknown title under an explicit source scope, Uni-CLI now resolves a durable
  canonical ref through the canonical lookup sources, then reruns the final
  evidence pass only inside the user's requested source scope.
- Preserved audit truth: the returned rows keep the original title route and
  merge first-pass source errors with canonical scoped source errors. Canonical
  lookup is used only as an identity-resolution seam, not as a substitute for
  scoped evidence.
- Tightened source-audit next actions. Source-scoped availability is emitted
  only for sources with source-scoped evidence capabilities. Discovery-only
  rows such as `baidu-scholar` and `zotero` now expose `next_search` plus
  `next_workflow_from_result`, `next_sources_from_result`, and
  `next_read_from_result` instead of a dead source-local availability command.
- Experiment ladder:
  - Reproduction before edit:
    `npm run --silent dev -- -f json scholar sources "Llama 2" --sources
baidu-scholar,zotero,arxiv -D` returned rows without `canonical_ref`, and
    discovery-only rows still advertised `next_source_availability 'Llama 2'`.
    Dev `scholar evidence "Llama 2" --sources baidu-scholar,zotero,arxiv -D`
    and dev `scholar reproduce "Llama 2" --sources
baidu-scholar,zotero,arxiv -D` both exited 66 with source-local title lookup
    errors.
  - Focused checks: `npm run typecheck` exited 0;
    `npx vitest run --project unit tests/unit/commands/scholar.test.ts
--maxWorkers=1 --reporter=dot` — 39 passed; `npm run lint` exited 0.
  - Source smokes: dev `scholar availability`, `scholar sources`,
    `scholar evidence`, and `scholar reproduce` for `"Llama 2" --sources
baidu-scholar,zotero,arxiv -D` now return `ok: true` with
    `canonical_ref=2307.09288` and final arXiv evidence. `scholar sources`
    reports baidu-scholar and zotero as discovery handoff rows without
    `next_source_availability`, while arXiv is `evidence_found` with scoped
    `next_read` and `next_download`.
  - Read smoke: dev `scholar read "Llama 2" --sources
baidu-scholar,zotero,arxiv --first-page 1 --last-page 1 --max-chars 1000`
    returned extracted arXiv PDF text for `2307.09288`.
  - Build/dist smoke: `npm run build` exited 0; `node dist/main.js -f json
scholar sources "Llama 2" --sources baidu-scholar,zotero,arxiv -D` and
    `node dist/main.js -f json scholar evidence "Llama 2" --sources
baidu-scholar,zotero,arxiv -D` returned the same canonicalized scoped evidence
    behavior through the built artifact.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2775
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this closes the shared title-to-canonical availability boundary
  for representative scoped scholarly meta commands. It does not add new
  graph/review/resource capabilities to baidu-scholar, zotero, or arXiv, and it
  does not make local Zotero reachable when its localhost fetch is blocked by
  the current safety policy.

## 2026-06-27 — Scholarly Workflow Canonical Retry Slice

- Root cause: `scholar workflow` still used the first availability pass only.
  When an Agent combined discovery-only sources with one evidence source, e.g.
  `scholar workflow "Llama 2" --sources baidu-scholar,zotero,arxiv -D`, the
  workflow sent the raw title to arXiv `id_list` and exited 66 with
  `SCHOLAR_WORKFLOW_NOT_FOUND`. That contradicted the coverage handoff contract:
  discovery results should feed the canonical scholarly workflow, not strand the
  Agent at a title-shaped source-local lookup.
- Added a workflow-only canonical retry. If the initial workflow availability
  pass fails for an unknown title under an explicit source scope, the command
  resolves the title through canonical lookup sources, reruns availability with
  the caller's original source scope and the canonical ref, then preserves the
  original title route plus merged source errors for auditability.
- Added `canonical_ref` and `canonical_ref_kind` to workflow rows so Agent JSON
  consumers can see the durable paper identifier directly instead of inferring
  it from `next_*` command strings.
- Tightened resource runbook readiness. `next_code` and `next_datasets` are now
  emitted only when resource evidence exists or the selected source scope has a
  matching resource-capable source. A narrow scope such as
  `baidu-scholar,zotero,arxiv` can be ready for reading without falsely marking
  code/dataset inspection as ready.
- Experiment ladder:
  - Reproduction before edit:
    `npm run --silent dev -- -f json scholar workflow "Llama 2" --sources
baidu-scholar,zotero,arxiv -D` exited 66 with
    `SCHOLAR_WORKFLOW_NOT_FOUND` after arXiv received
    `id_list=Llama%202`.
  - Additional dead-end check: dev `scholar code 2307.09288 --sources
baidu-scholar,zotero,arxiv -D` and dev `scholar datasets 2307.09288 --sources
baidu-scholar,zotero,arxiv -D` both exited 66 because none of the selected
    sources exposes `scholar.code` or `scholar.datasets`.
  - Focused checks: `npm run typecheck` exited 0;
    `npx vitest run --project unit tests/unit/commands/scholar.test.ts
--maxWorkers=1 --reporter=dot` — 39 passed; `npm run lint` exited 0.
  - Source smokes: dev `scholar workflow "Llama 2" --sources
baidu-scholar,zotero,arxiv -D` now returns `ok: true`,
    `canonical_ref=2307.09288`, `canonical_ref_kind=arxiv`, arXiv readable/PDF
    evidence, ready read/download steps, blocked graph/review/resource steps,
    and no `next_code`/`next_datasets` dead-end commands.
  - Regression smoke: default dev `scholar workflow "Llama 2" -D` still
    returns the broad ready workflow with graph, review, and HF resource
    commands, proving the resource-readiness tightening did not remove the
    complete default closed loop.
  - Build/dist smoke: `npm run build` exited 0; `node dist/main.js -f json
scholar workflow "Llama 2" --sources baidu-scholar,zotero,arxiv -D` returned
    the same canonicalized readable workflow and blocked resource inspection
    through the built artifact.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2775
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this proves workflow recovery for a representative
  title-to-arXiv canonical path and prevents resource-ready false positives for
  a narrow non-resource source set. It does not add graph/review/resource
  capability to baidu-scholar, zotero, or arXiv, and it does not change the
  broader availability command's first-pass behavior.

## 2026-06-27 — Scholarly Discovery Handoff Coverage Slice

- Root cause: `scholar coverage --sources all --gaps -D` correctly surfaced
  discovery-only scholarly sources such as `baidu-scholar` and `zotero`, but
  their Agent-facing rows still emitted `next_availability` commands scoped to
  those sources. Those sources currently expose `scholar.search` without
  source-scoped `scholar.get`/`scholar.pdf`/`scholar.code`/`scholar.datasets`
  evidence, so the old coverage output could send an Agent into a dead
  availability/read path instead of handing the discovered result back to the
  canonical scholarly workflow.
- Added a capability-derived `handoff_strategy` to scholar coverage rows.
  Source-scoped evidence providers keep `next_availability` and `next_read`;
  discovery-only sources now expose `next_search` plus
  `next_workflow_from_result`, `next_sources_from_result`, and
  `next_read_from_result`, making the intended post-search handoff explicit
  for Agent loops.
- The coverage table now separates "this site can provide evidence for this
  ref" from "this site can discover candidate refs." That preserves broad
  academic-site coverage while preventing fabricated source-local availability
  promises for sites that cannot yet prove artifacts, code, datasets, or
  records by identifier.
- Experiment ladder:
  - Reproduction before edit:
    `npm run --silent dev -- -f json scholar coverage --sources all --gaps -D`
    exited 0 and showed 19 scholarly gap rows. `baidu-scholar` and `zotero`
    appeared as discovery-only sources with `scholar.search`, but still emitted
    source-scoped `next_availability` commands.
  - Non-blocking observation:
    `npm run --silent dev -- -f json scholar doctor --sources all -D` rejected
    `-D` with `error: unknown option '-D'`; this slice did not change doctor
    option parsing.
  - Focused checks: `npm run typecheck` exited 0;
    `npx vitest run --project unit tests/unit/commands/scholar.test.ts
--maxWorkers=1 --reporter=dot` — 38 passed; `npm run lint` exited 0.
  - Source smokes: dev `scholar coverage --sources
baidu-scholar,zotero,arxiv -D` now reports `arxiv` as
    `source-scoped-evidence` with `next_availability` and `next_read`, while
    `baidu-scholar` and `zotero` report
    `discovery-result-to-canonical-workflow` with no source-scoped
    availability/read commands and with canonical result handoff commands.
  - Discovery smoke: dev `search "学术网站覆盖矩阵 对比 获取"` ranked
    `scholar coverage` first, followed by `scholar read`, `scholar code`,
    `scholar download`, and `scholar datasets`.
  - Build/dist smoke: `npm run build` exited 0; `node dist/main.js -f json
scholar coverage --sources baidu-scholar,zotero,arxiv -D` returned the same
    source-scoped evidence versus discovery-only handoff split through the
    built artifact.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2774
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this proves the coverage/runbook layer no longer advertises
  dead source-scoped availability for discovery-only scholarly sites. It does
  not add new baidu-scholar or zotero artifact adapters, and it does not change
  doctor option parsing.

## 2026-06-27 — Scholarly Source-Scoped Artifact Canonicalization Slice

- Root cause: canonical next commands were fixed, but direct user/Agent calls
  could still fail when the user constrained the final source. Reproduction:
  `scholar read "Llama 2" --source arxiv` exited 66 with
  `SCHOLAR_READ_NOT_FOUND` because the arXiv adapter received the title
  directly and queried `id_list=Llama%202`; arXiv search rows do not provide
  enough PDF metadata to complete the artifact loop from that title alone.
- Added a bounded canonical identity lookup set for source-scoped operations.
  Unknown-title `citations`/`references` continue to canonicalize before graph
  lookup, and source-scoped `read`/`download` now canonicalize only when the
  caller explicitly passes `--source` or `--sources`, preserving the fast
  default artifact path while repairing source-specific user intent.
- The final source is still respected: canonical lookup may use first-source
  scholarly evidence to resolve `Llama 2 -> 2307.09288`, but `--source arxiv`
  still downloads/reads from arXiv, and `--source semantic-scholar` still
  returns Semantic Scholar graph rows.
- Experiment ladder:
  - Reproduction before edit:
    `npm run --silent dev -- -f json scholar read "Llama 2" --source arxiv
--output /tmp/unicli-scholar-read-arxiv-smoke --first-page 1 --last-page 1
--max-chars 1000` exited 66 with `SCHOLAR_READ_NOT_FOUND`.
  - Focused checks: `npm run typecheck` exited 0;
    `npx vitest run --project unit tests/unit/commands/scholar.test.ts
--maxWorkers=1 --reporter=dot` — 38 passed.
  - Source smokes: the same dev `scholar read "Llama 2" --source arxiv`
    command returned arXiv PDF text for `2307.09288`; dev
    `scholar download "Llama 2" --source arxiv` returned arXiv artifact
    metadata; dev `scholar citations "Llama 2" --source semantic-scholar -D`
    returned 20 citation rows.
  - Build/dist smoke: `npm run build` exited 0; `node dist/main.js -f json
scholar read "Llama 2" --source arxiv --output
/tmp/unicli-scholar-read-arxiv-dist-smoke --first-page 1 --last-page 1
--max-chars 1000` returned arXiv PDF text for `2307.09288`.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2774
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this proves the representative source-scoped arXiv artifact
  loop and Semantic Scholar graph loop. It does not claim every ambiguous title
  has enough evidence in the canonical lookup set, and it intentionally avoids
  running source-code installs or repository commands during read/download.

## 2026-06-27 — Scholarly Canonical Reference Handoff Slice

- Root cause: `scholar availability` and `scholar sources` could resolve an
  ambiguous title such as `Llama 2` into a real paper identity, but their
  Agent-facing `next_*` commands still propagated the original title. That
  broke graph commands such as `scholar citations "Llama 2"` when a downstream
  source required an arXiv/DOI/Semantic Scholar/OpenReview identifier, and it
  left per-source audits showing first-pass title lookup failures as blocking
  even after the canonical paper identity was known.
- Added canonical identity handoff fields to availability and source-audit rows:
  `canonical_ref` and `canonical_ref_kind`. Availability now derives the
  canonical reference from fused records, preferring arXiv id, DOI, PMID,
  OpenReview forum id, then Semantic Scholar id, and every non-review
  Agent-facing next command uses that reference.
- Direct citation/reference graph lookups now canonicalize unknown title refs
  through the availability collector before invoking graph sources, so a user
  or agent can call `scholar citations "Llama 2"` and still reach the graph
  source with `2307.09288` when the source set contains resolvable evidence.
- `scholar sources` now performs a canonical second-pass source probe when the
  canonical ref differs from the original ref. Source rows keep full
  `source_errors` for auditability, but recovered title-lookup failures move to
  `recovered_errors` and no longer appear as `blocking_errors` once canonical
  evidence has been returned.
- Experiment ladder:
  - Reproduction before edit:
    `scholar availability "Llama 2" --sources
hf,huggingface-papers,arxiv,semantic-scholar -D` resolved arXiv
    `2307.09288` but emitted `next_citations` with `'Llama 2'`;
    `scholar citations "Llama 2" --sources semantic-scholar -D` exited 66
    with `SCHOLAR_NOT_FOUND`; `scholar citations "2307.09288" --sources
semantic-scholar -D` returned 20 rows.
  - Focused checks: `npm run typecheck` exited 0;
    `npx vitest run --project unit tests/unit/commands/scholar.test.ts
--maxWorkers=1 --reporter=dot` — 38 passed.
  - Source smokes: dev `scholar availability "Llama 2" --sources
hf,huggingface-papers,arxiv,semantic-scholar -D` now emits
    `canonical_ref=2307.09288` and canonical `next_read`, `next_code`,
    `next_datasets`, `next_citations`, and `next_references`; dev
    `scholar citations "Llama 2" --sources
hf,huggingface-papers,arxiv,semantic-scholar -D` returned 20 rows.
  - Source-audit smoke: dev `scholar sources "Llama 2" --sources
hf,huggingface-papers,arxiv,semantic-scholar -D` returned four source rows
    with arXiv and Semantic Scholar classified as `evidence_found`, canonical
    next commands, empty `blocking_errors`, and original title lookup failures
    preserved under `recovered_errors`.
  - Build/dist smoke: `npm run build` exited 0; `node dist/main.js -f json
scholar sources "Llama 2" --sources
huggingface-papers,arxiv,semantic-scholar -D` returned canonical
    `2307.09288` source rows through the built artifact.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2774
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this proves canonical handoff for representative title to
  arXiv graph/source flows. It does not claim every ambiguous title can be
  canonicalized from every single-source restriction, and review-thread
  commands intentionally keep the original ref unless the canonical identity is
  an OpenReview forum id.

## 2026-06-27 — Scholarly Per-Source Provenance Matrix Slice

- Root cause: `scholar availability` could fuse source evidence into one row,
  but agents could not see which site contributed which evidence, which sites
  only had candidate graph/review capability, and which source-local errors
  were blocking. Unknown-title fallbacks also allowed broad title matches and
  list/trending commands to leak unrelated papers into a paper-specific
  evidence row.
- Added `unicli scholar sources <ref>` with alias `source-audit`. It emits a
  per-source provenance matrix with `source_status`, `evidence_types`,
  record/resource booleans, source capabilities, executed/candidate
  capabilities, per-source next commands, `source_errors`, and
  `blocking_errors`, without downloading artifacts or executing code.
- Fixed internal scholar fan-out argument normalization by reusing the shared
  `resolveArgs` coercion path after filtering to the target adapter schema.
  This keeps internal calls aligned with CLI/MCP/ACP type semantics instead of
  passing raw meta-command strings into the kernel.
- Fixed Hugging Face Papers `daily` schema so `limit` is an integer, refreshed
  the generated manifest, and added loader coverage for that adapter contract.
- Added an unknown-title relevance gate for PDF/code/dataset fallback records:
  short aliases now require title-prefix evidence, and title-search fallbacks
  no longer treat source list/trending rows as paper-specific evidence.
- Experiment ladder:
  - Static and focused tests: `npm run typecheck` exited 0;
    `npx vitest run --project unit tests/unit/loader.test.ts tests/unit/commands/scholar.test.ts tests/unit/search.test.ts --maxWorkers=1 --reporter=dot`
    — 118 passed.
  - Manifest smoke: `npm run build:manifest` exited 0; `unicli describe
huggingface-papers daily` now reports `limit` as JSON Schema `integer`.
  - Source smokes: `scholar sources "Llama 2" --sources
hf,huggingface-papers,arxiv,semantic-scholar -D` returned four source rows,
    retained HF/Hugging Face Papers evidence for arXiv `2307.09288`, and no
    longer counted an unrelated Semantic Scholar PDF merely because its title
    mentioned `Llama 2`.
  - Routing smokes: English per-source comparison queries and Chinese
    `论文来源逐站点对比` rank `scholar sources` first; broad availability and
    reproducibility queries still route to `scholar availability` and
    `scholar reproduce`.
  - Build and dist smokes: `npm run build` exited 0; `node dist/main.js -f
json describe huggingface-papers daily` reports integer `limit`, and
    `node dist/main.js -f json scholar sources "Llama 2" --sources
hf,huggingface-papers,arxiv,semantic-scholar -D` preserves the same
    conservative source matrix.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2774
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this slice proves the per-source audit contract, internal
  argument parity, generated-manifest schema, routing, and representative
  unknown-title relevance guard. It does not claim all upstream scholarly
  sources are reachable without API keys/rate-limit relief, nor that ambiguous
  short aliases should be treated as citation-ready before `scholar read`
  returns source text.

## 2026-06-27 — Scholarly Agent Workflow Runbook Slice

- Root cause: the scholarly surface had strong point commands
  (`availability`, `evidence`, `reviews`, `reproduce`, `read`, `download`,
  `code`, `datasets`, `citations`, `references`), but no single
  machine-readable ordering contract telling an agent what to do first, what is
  blocked, and what must not be cited or executed yet. That left the
  anti-hallucination loop dependent on prompt memory instead of a command
  surface.
- Added `unicli scholar workflow <ref>` with alias `runbook`. It reuses the
  availability collection boundary, emits `workflow_status`, `next_step`,
  `claim_boundary`, `execution_boundary`, `completed_steps`, `pending_steps`,
  `blocked_steps`, and an ordered `agent_runbook` with `done_when` and `guard`
  fields. It never downloads, clones, installs, runs remote code, or summarizes
  paper claims.
- Added `next_workflow` and `next_reproduce` to availability rows so downstream
  agents can move from discovery into the full closed loop without
  reconstructing shell commands.
- Added core discovery metadata plus English/Chinese intent routing so queries
  such as `academic paper closed-loop workflow runbook for agent reading` and
  `学术资源完整闭环工作流` rank `scholar workflow` first instead of jumping to a
  single artifact command.
- Tightened wording after dist smoke: citation/reference and review entries in
  `completed_steps` are named as candidates (`citation_reference_candidate_*`)
  until the agent actually runs the graph/review commands.
- Experiment ladder:
  - Focused implementation tests:
    `npx vitest run --project unit tests/unit/commands/scholar.test.ts tests/unit/search.test.ts --maxWorkers=1 --reporter=dot`
    — 102 passed.
  - Static checks: `npm run typecheck` and `npm run lint` both exited 0.
  - Source smoke:
    `npm run --silent dev -- -f json scholar workflow "Llama 2" --sources hf,huggingface-papers,arxiv,semantic-scholar -D`
    returned `workflow_status=ready_for_agent_reading`,
    `next_step=run_next_read_before_quoting_claims`, source-backed arXiv
    anchor, readable/resource/graph candidates, and no remote execution.
  - Source search smokes: English and Chinese closed-loop queries both ranked
    `scholar workflow` first.
  - Build and dist smokes: `npm run build` exited 0; `node dist/main.js -f json
scholar workflow "Llama 2" --sources
hf,huggingface-papers,arxiv,semantic-scholar -D` returned the same runbook
    shape with candidate-safe wording.
  - Full verification: `npm run verify` exited 0. Unit tests: 241 files, 2769
    passed, 2 skipped. Adapter tests: 169 files, 6462 passed. Perf, compute
    coverage, adapter-test coverage, agent-size, stats consistency,
    conformance (943 passed, 42 quarantined, 0 failed), exports, changesets
    default-branch skip, and boundary guard all passed.
- Residual risk: this slice proves the command contract, routing, build
  artifact, and representative Llama 2 source flow. It does not claim every
  scholarly upstream is currently reachable, that graph/review candidates have
  returned rows before their next commands run, or that install/run is safe
  without repository and data inspection. The broader goal remains active.

## 2026-06-19 — Security Advisory Credit and Publication

- Context: Ryan Vonbrubeck requested public credit as `@dodge1218` after the
  legacy HTTP MCP Origin-validation fix had already shipped in `v0.225.2`.
- Confirmed affected range from git tags: `v0.225.1` legacy
  `src/mcp/http-transport.ts` accepted requests before any shared Origin guard,
  while `v0.225.2` includes `src/mcp/origin-guard.ts`. The command
  `git tag --contains d675c267` returns only `v0.225.2`.
- Published GitHub Security Advisory
  `GHSA-v3f4-w7r7-v3hm` for npm package `@zenalexa/unicli`, vulnerable range
  `< 0.225.2`, patched version `0.225.2`, severity `high`, CWE-346 and
  CWE-352.
- Requested a CVE from GitHub for the advisory; the API accepted the request
  with an empty 202-style body, and `cve_id` remains pending/null as of this
  entry.
- Added `@dodge1218` as Finder credit in the advisory. GitHub shows the credit
  state as `pending`, which means Ryan must accept before the public advisory
  displays it.
- Updated GitHub Release `v0.225.2` to include the security summary, GHSA link,
  and release-note credit.
- Updated repository docs: `CHANGELOG.md` now credits Ryan beside the
  `0.225.2` security entry, and `SECURITY.md` now states the reporter-credit
  policy.
- Verification: `git diff --check -- CHANGELOG.md SECURITY.md`,
  `npx prettier --check CHANGELOG.md SECURITY.md`, GHSA readback, and GitHub
  Release readback all exited 0 or returned the expected remote state.
- Residual risk: GitHub Advisory Database / Dependabot review and CVE
  assignment are asynchronous GitHub-side processes; monitor the advisory until
  `cve_id` and accepted credit are visible if Ryan accepts the credit request.

## 2026-06-02 — Browser Automation Timeout Repair

- Root cause: commit `7f1a1efc` made browser delivery daemon-first and trusted any extension that found a Uni-CLI `/ping`; the live 9222 profile was running an incompatible OpenCLI extension that sent only `{type:"hello", version}`. The daemon marked it connected, commands waited until the 30s client timeout, and doctor reported `ready` while carrying `session_error`. Commit `c43cb7dc` then made this harder to diagnose by reporting the default path ready when local CDP was reachable.
- Added protocol identity to the extension hello (`product=unicli`, `protocol=unicli-browser-bridge`) and made the daemon reject legacy/incompatible hello messages before reporting `extensionConnected` or accepting commands.
- Routed authenticated browser commands (`cookie`, `header`, `intercept`) to `browserSession=user` by default, then made that path prefer the selected profile automation directory under `~/.unicli/browser-profiles/` before falling back to the default 9222 automation profile.
- Fixed two follow-on live failures: automation profile CDP reuse now recovers the port from the process list when `DevToolsActivePort` is absent, and CDP HTTP discovery uses `127.0.0.1` instead of `localhost` to avoid the local host mapping that returned HTTP 404 on this machine.
- Made future local CDP launches pass `--disable-extensions`, so a repaired automation profile cannot reload stale profile extensions into the CDP path.
- Hardened `browser sessions -f json` so an unavailable/incompatible extension bridge emits a structured v2 error envelope instead of a raw Node stack.
- Final audit found and fixed three adjacent real issues after the timeout repair: CDP target selection now rejects non-page targets (`iframe`, `webview`, `other`, `app`, service/background targets) and creates a real page when Chrome exposes only internal targets; `xiaohongshu.feed` now has a TypeScript adapter with store/API-first plus visible-DOM fallback; `weibo.trending` sends the Referer required by the public `hotSearch` endpoint instead of falsely reporting auth as required.
- Experiment ladder: reproduced pre-fix `browser doctor` at 30.1s with `extension_connected=true` plus timeout diagnostics; verified daemon logs rejecting `[opencli]` hello after restart; restarted the 9222 automation Chrome with `--disable-extensions`; live `browser doctor --json` now returns ready on the default local-CDP path; live `twitter tweets kalomaze --limit 1 -f json` succeeds with one tweet; live `xiaohongshu feed --limit 1 -f json` now returns a real note; live `xiaohongshu trending --limit 1 -f json` returns a hot-note fallback row; live `reddit user-posts spez --limit 1 -f json`, `youtube search openai --limit 1 -f json`, `bilibili trending --limit 1 -f json`, and `weibo trending --limit 1 -f json` all return one row; `browser sessions -f json` returns a structured error when the extension bridge is unavailable.
- Verification: `npm run typecheck`, `npm run lint`, touched-files `prettier --check`, targeted CDP/XHS/Weibo/surface tests (30 passed, 1 skipped), and full `npm test` (237 files passed, 2684 passed, 2 skipped).
- Residual risk: an old incompatible OpenCLI extension from another installed browser profile still attempts to reconnect and is rejected; it no longer blocks delivery or creates 30s waits. The repaired 9222 automation Chrome now runs with `--disable-extensions`. Local CDP fallback is the working delivery path for authenticated site commands. `browser doctor` still reports the daemon extension bridge as `needs-extension`, so the system is not "perfect"; it is functional on the default local-CDP delivery path. Parallel live commands can still race on the same CDP page target; run social-site probes sequentially until page-target leasing is made per-command.

## 2026-05-31 — Step 2/5 Unified Operation Contracts

- Root cause: adapter commands used `CommandContract`, but core Commander
  commands (`compute`, `browser`, `delivery`, `runs`, `mcp`, `agents`, and
  `architecture`) still exposed schemas and architecture inventory through a
  parallel `CoreDiscoveryCommand` path. That kept the universal computer-control
  model split at the operation boundary.
- Added `buildCoreCommandContract()` in `src/core/command-contract.ts`. Core
  contracts now carry identity, input schema, target surface, effect,
  governance, explicit unknown eval status, and `repair.source_kind: "core"`
  with `source_path`. They intentionally do not invent adapter-only
  `adapter_path` or `repair_command` fields.
- Updated architecture inventory to derive core command target surface and
  safety class from the contract builder instead of hardcoding
  `safety_class: "control"`.
- Updated slow runtime `describe` and fast-path `describe` so
  `describe compute capture` exposes the same core contract as adapter command
  descriptions.
- Experiment ladder: added failing contract/describe/fast-path/architecture
  tests, observed missing `buildCoreCommandContract`, missing runtime core
  describe payload, missing fast-path contract, and hardcoded core safety class;
  implemented the core projection and reran the same suite to green.
- Verification: focused contract/architecture/fast-path suite passed with 36
  tests; adjacent contract/architecture/MCP fast-path suite passed with 55
  tests; `npm run typecheck`, `npm run lint`, `describe compute capture`, and
  `architecture audit` exited 0. The CLI describe probe confirmed core tags are
  de-duplicated as `["core", "desktop"]`.
- Residual risk: full `npm test` was attempted but stopped after more than ten
  minutes without a Vitest summary, so full-suite completion remains
  unverified. Full `npm run verify` still needs to run after this step;
  independent subagent audit was not spawned because the available tool
  requires an explicit delegation request.

## 2026-05-31 — Universal Computer-Control Reframe

- Root cause: the previous "agent control plane" wording still allowed the
  product to be read as a better tool catalog, execution layer, MCP wrapper, or
  adapter collection. The user clarified the intended category is larger:
  Uni-CLI is the universal hand by which agents control computers; browser
  automation, computer-use sandboxes, natural-language local execution, MCP, and
  per-site wrappers are substrates below it.
- Replaced the top-level public model across README, package metadata, docs
  sources, VitePress homepage/config, FAQ, glossary, getting-started,
  integrations, roadmap, and architecture docs with the computer-control loop:
  intent -> select -> govern -> act -> observe -> diagnose -> repair/reroute ->
  deliver -> expose.
- Rebuilt `src/core/architecture-tree.ts` around
  `COMPUTER_CONTROL_STAGES`, `computer-control-platform`,
  `operation-contract`, `control-kernel`, `action-substrates`,
  `evidence-delivery-loop`, and `runtime-exposure`. The old command lifecycle
  stays as an internal authoring cycle, not the product root.
- Updated `src/discovery/core-catalog.ts`, `src/commands/architecture.ts`, and
  focused tests so `architecture tree/audit` enforce the new topology and
  non-product identity boundaries.
- Experiment ladder so far: wrote failing architecture tests against the new
  topology, observed red failures for missing `COMPUTER_CONTROL_STAGES` and old
  `first-class-citizens`, implemented the root replacement, then reran
  `npx vitest run tests/unit/core/architecture-tree.test.ts tests/unit/commands/architecture.test.ts`
  to green with 8 tests.
- Verification: focused architecture tests passed with 8 tests; `npm run
typecheck`, `npm run lint`, `npm run docs:build`, `npm run docs:check-public`,
  `npm test`, `npm run boundary:check`, and `architecture audit` all exited 0.
  Full `npm test` passed with 232 test files, 2656 tests, and 2 skipped after a
  release metadata regression in FAQ version pins was fixed in
  `scripts/release.ts`.

## 2026-05-31 — Agent Control Plane Repositioning

- Root cause: the architecture model treated adapter manifest commands as the
  callable architecture, but the product's control plane also includes core
  Commander commands such as `compute`, `browser`, `delivery`, `runs`, `mcp`,
  `agents`, and `architecture`.
- Reframed README/package/docs architecture thesis around Uni-CLI as the agent
  control plane for real software: intent discovery, governed execution, state
  observation, result delivery, diagnosis/repair, and reuse.
- Added core command source paths in `src/discovery/core-catalog.ts`, merged core
  commands into `src/core/architecture-tree.ts`, and wired
  `src/commands/architecture.ts` so `architecture tree/audit` covers adapter and
  core command inventories.
- Result: `architecture audit` now reports 321 sites, 1819 total commands, 1783
  adapter commands, 36 core commands, 627 local-computer-use commands, and 0
  missing source paths. `unicli list -f json` also reports 1819 commands.
- Experiment ladder: read README/docs/runtime structure, ran architecture/list
  probes, added focused regression tests, then ran
  `npx vitest run tests/unit/core/architecture-tree.test.ts tests/unit/commands/architecture.test.ts`,
  `npm run typecheck`, `npm run lint`, and `npx tsx src/main.ts architecture audit -f json`.
- Full `npm test` was attempted after focused verification, but the Vitest
  process idled for about seven minutes without a final summary and was killed.
- Residual risk: this aligns the callable architecture inventory and public
  architecture thesis. It does not yet project core Commander commands through
  the full `CommandContract` path, prove individual live desktop/web workflows,
  or provide a completed full unit-suite result for this dirty worktree.

## 2026-05-27 — Marxists.org Chinese Archive Adapter

- Root cause: `unicli search` had no structured route for `https://www.marxists.org/chinese/index.html`, so agents asking for Marxist philosophy, people, books, or primary-source content were pushed toward generic web/scholarly search instead of the Chinese Marxists archive.
- Added the public `marxists-cn` TypeScript adapter with `index`, `authors`, `works`, `search`, `read`, `reading-list`, and `western-marxism` commands. The adapter constrains all URLs to `https://www.marxists.org/chinese/`, sniffs UTF-8 vs GB18030/GBK/GB2312 pages, extracts top-level people/topic directories, parses author/topic work lists, reads HTML pages as plain text, returns a station-verified Western Marxism reading list, and supports bounded scoped full-text search.
- Added discovery aliases and a narrow intent boost so Marxism/philosophy/archive retrieval queries route to `marxists-cn search` before generic paper search, while Western Marxism canon/reading-list queries route to `marxists-cn western-marxism`.
- Result: `list --site marxists-cn` reports seven commands; `search "马克思主义 哲学 文库 检索"` ranks `marxists-cn search` first; `search "读 西马 著名人物 著名著作"` ranks `marxists-cn western-marxism` first and `marxists-cn reading-list` second; `marxists-cn search "共产党宣言"` returns the Marx and Engels archive entries; `marxists-cn read marx/01.htm` returns title, author, date, full character count, and clean text for 《共产党宣言》.
- Experiment ladder: live `unicli search` showed no existing Marxists coverage; fetched and decoded the live GB2312/UTF-8 archive pages; added parser/unit tests, search routing regression, live CLI index/works/search/read probes, regenerated manifest/stats/docs, then ran targeted typecheck/lint/unit/adapter checks, `npm run docs:check-public`, `git diff --check`, and full `npm run verify`. A later Western Marxism probe first failed to route `search "读 西马 著名人物 著名著作"` to `marxists-cn`; the repair added station-verified reading-list commands, regenerated fast-path manifests, and re-ran the same search/read probes until they returned `western-marxism`, `reading-list`, and readable 卢卡奇 text.
- Residual risk: full-text search is intentionally scoped by `--scope` to prevent unbounded crawling of the whole archive in one command. PDF/CHM/MP3 resources are listed as works/resources, but `read` only extracts HTML/text; binary document parsing remains a separate reader/download workflow.

## 2026-05-27 — Twitter/X Coverage Repair

- Root cause: Twitter/X runtime had a user timeline command under `tweets`, but no natural `user-tweets` command, no direct `comments` command, URL inputs to `thread` were passed through as raw tweet IDs, and the generated manifest could drift from runtime TS registrations when commands were hidden behind helper registration.
- Rebuilt the Twitter/X user timeline surface so `tweets`, `user-tweets`, and `user-timeline` are explicit manifest-visible commands; they normalize `@handles`, use browser readability checks, emit the standard tweet row shape, and throw structured empty-result errors instead of silently returning `[]`.
- Added a targeted discovery intent so `unicli search "X user timeline"` ranks `twitter user-timeline` above the home timeline command while plain `twitter timeline` remains unchanged.
- Added `twitter comments` as a cookie-auth command over the existing TweetDetail thread reader, and made both `thread` and `comments` accept numeric tweet IDs or Twitter/X status URLs.
- Fixed Twitter social capability coverage by marking `post` as `write_post`, and added manifest scanner regression tests so these TS commands cannot disappear from fast-path `list/search`.
- Result: fast-path `list --site twitter` now reports 47 Twitter commands; `search "twitter comments replies"` returns `twitter comments`; `search "X user timeline"` returns `twitter user-timeline`; `twitter comments <url> --dry-run` reports `strategy: cookie` and `domain:x.com`.
- Experiment ladder: red adapter tests for `user-tweets`, `user-timeline`, `comments`, URL/id parsing, `/i/status` extraction, and social audit; red search test for X user timeline intent; regenerated manifest/stats/docs; `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:adapter`, `npm run format:check`, `npm run stats:check`, `npm run lint:schema-v2`, `npm run docs:check-public`, `git diff --check`, plus fast-path CLI discovery/dry-run probes.
- Residual risk: this proves command registration, generated discovery, dry-run metadata, parser behavior, and DOM-extraction contracts. It does not prove live X/Twitter currently returns rows for every authenticated account, because that depends on local browser login, X anti-bot state, and live DOM/API drift.

## 2026-05-26 — Site Smoke and Search Complexity Audit

- Used the built Uni-CLI against its own catalog: `list` reports 319 visible surfaces and 1,806 commands, including core/dynamic surfaces; `architecture audit` reports 311 adapter sites, 1,770 loaded commands, 611 local-computer-use commands, and zero missing source paths.
- Live public-command smoke passed for `hackernews top`, `arxiv search`, `coingecko top`, and `wttr current`; earlier same-session smoke also passed for `npm package` and `wikipedia summary`.
- Conformance result: 977 adapters across 221 adapter sites, 935 passed, 0 failed, 42 quarantined. Browser doctor reports default local CDP ready, but background extension bridge still `needs-action`, and 90 visible surfaces include auth-required commands.
- Complexity fix: replaced per-search full registry signature generation with an O(1) registry version check, reused postings for site/category candidate expansion, cached normalized site phrases in the index, and replaced default full candidate sorting with bounded top-k insertion.
- Result: search eval stayed unchanged at 73.49% Top-1, 83.47% Top-3, 85.76% Top-5, 71.58% Chinese Top-5, and 91.82% English Top-5. Micro-benchmark improved from 1,500 queries in 21.33s (14.2181 ms/query) to 18.89s (12.5924 ms/query).
- Experiment ladder: `unicli search/list/architecture audit/browser doctor`, `npm run conformance`, six live public command smokes, complexity scanner, targeted search/fast-path/MCP tests, micro-benchmark before/after, and full `npm run verify`.
- Residual risk: this does not prove every live third-party site works right now. Full live validation still needs a scheduled sweep that classifies auth-required, quarantined, browser-required, rate-limited, region-blocked, and upstream-changed commands separately.

## 2026-05-26 — Live Registry Search Rewrite

- Demolished the generated runtime search-index path: `scripts/build-manifest.js` no longer writes `dist/manifest-search.json`, and runtime discovery no longer reads or falls back to generated BM25 artifacts.
- Root cause removed: search had a second source of truth separate from command creation/invocation. Generated manifest search could miss runtime/user-registered commands that the live registry could invoke, so discovery and execution were not a closed loop.
- Rebuilt `src/discovery/search.ts` around `CommandSearchDocument` inputs: normal CLI/MCP search indexes the live registry plus core commands, while fast-path search projects `dist/manifest.json` into the same scorer instead of owning separate search semantics.
- Added a red regression proving a runtime-only command is discoverable after registration; updated direct search, command, and MCP tests to load the live registry boundary used by real CLI/MCP startup.
- Experiment ladder: red runtime-only search test, targeted search/fast-path/MCP/command suites, formatter/typecheck/lint, one failed then three passing full `npm run verify` runs, `npm run docs:build`, built CLI self-use for Twitter/social search, scholarly category search, and `architecture audit`, plus `test ! -e dist/manifest-search.json`.
- Result: `npm run verify` and `npm run docs:build` pass. Search eval reports 73.49% Top-1, 83.47% Top-3, 85.76% Top-5, 71.58% Chinese Top-5, and 91.82% English Top-5 against the live registry.
- Residual risk: this proves in-repo command discovery, fast-path projection, MCP search, adapter conformance, generated docs, and absence of the old artifact. It does not prove every live third-party command succeeds against current upstream network/auth/UI conditions.

## 2026-05-26 — Architecture Tree and Repairability Audit

- Added the callable `architecture tree` and `architecture audit` commands so agents can inspect Uni-CLI's first-class architecture roots, command lifecycle, local-computer-use coverage, second-class surfaces, and per-command repair source paths through the normal CLI envelope.
- Reworked adapter loading and TypeScript registration so YAML, static TS stubs, loop-generated TS commands, cross-site TS registrations, and user adapters preserve repairable `adapter_path` metadata.
- Experiment ladder: red architecture command/tree tests, red loader source-path tests, targeted loader/architecture/quarantine/parity suites, source and built CLI self-use, `npm run verify`, and `npm run docs:build`.
- Result: `architecture audit` now reports 311 sites, 1,770 loaded commands, 611 local-computer-use commands, zero missing source paths, and `ready_for_full_rewrite: true`; full verify and docs build pass.
- Residual risk: this validates the in-repo command contracts, loader/runtime parity, adapter schema/conformance, and generated docs. It does not prove every live third-party website currently succeeds against the network, logged-in state, rate limits, or upstream UI changes; that still needs a scheduled live adapter sweep.

## 2026-05-26 — Compute Cursor UI Rewrite

- Replaced the old neon arrow cursor vocabulary with `aperture-reticle-v1` across `visual_timeline`, docs replay, and macOS/Windows/Linux native overlay request/render paths.
- Experiment ladder: red cursor style test, red visual timeline state test, targeted unit suites, `npm run typecheck`, `npm run lint`, `npm run docs:build`, generated Swift parse, generated Linux Python compile, full `npm test`, and a live macOS `compute click --overlay` smoke.
- Result: all listed checks passed. The live macOS smoke returned `macos-appkit` / `arrived` and evidence with `aperture-reticle-v1`, `press`, `pressure`, and `click_ripple`.
- Residual risk: PowerShell parse was skipped because `pwsh` is not installed on this macOS host. Windows/Linux native behavior is covered here by shared request contracts, source guards, and generated Python compilation, but still needs real OS sidecar smoke on those platforms.

## 2026-05-26 — Mac Pointer Skin Rewrite

- Replaced the reticle cursor direction with `mac-glass-pointer-v1`: a Mac-style arrow skin with a real top-left hotspot, lift shadow, travel trace, arrival-gated press bloom, busy orbit, and success/error states.
- Experiment ladder: red cursor-style expectations, targeted cursor/overlay/timeline suites, generated Swift parse, generated Linux Python compile, local docs screenshot inspection, live macOS `compute click --overlay` smoke, `npm run typecheck`, `npm run lint`, `npm run docs:build`, `git diff --check`, and full `npm test`.
- Result: all listed checks passed. The live macOS smoke returned `macos-appkit` / `arrived` and evidence with `mac-glass-pointer-v1`, `mac-pointer`, `lift-shadow`, `pressure-bloom`, and `success-spark`.
- Residual risk: PowerShell parse remains skipped because `pwsh` is not installed on this macOS host; Windows/Linux real native sidecar smoke still requires those OSes.

## 2026-05-31 — 0.225.0 Computer-Control Release Candidate

- Root cause: after the five-step architecture reshape, the repo still needed a
  final release audit, stale release-doc cleanup, generated documentation sync,
  and a semver-minor `0.xxx.0` candidate that reflected the larger
  universal-computer-control product category.
- Prepared `0.225.0 — Apollo · Irwin`: updated package/lock metadata, README
  footers, AGENTS.md, skills, server.json, CHANGELOG, docs/release-info.json,
  roadmap/FAQ version pins, generated public docs, and release reference docs.
- Historical audit baseline: checked npm latest (`0.224.1`), latest local tag
  (`v0.224.1`), and release history from `0.200.0` through `0.224.1`. Folded the
  audit into tracked release reference docs rather than new ignored
  `docs/reference/release-audit.md` files, because local `.git/info/exclude`
  hides new paths below `reference/`.
- Final review fix: `npm run verify` first failed on Prettier formatting. Ran
  Prettier on the reported files, then reran the full gate to success.
- Experiment ladder: npm registry/tag audit, stale-doc grep, release metadata
  propagation, docs build, full `npm run verify`, strict release check,
  architecture audit probe, `git diff --check`, and `npm publish --dry-run`.
- Result: `npm run verify` passed; unit tests passed 233 files / 2664 tests / 2
  skipped; adapter tests passed 168 files / 6426 tests; `docs:build` passed with
  150 public files; `release:check -- --strict-codename` passed 23/23;
  `npm publish --dry-run` produced `zenalexa-unicli-0.225.0.tgz` with shasum
  `1ff26e95393ba7da147f9df77e6ff99b3cfc3a31`.
- Residual risk: this is a verified local release candidate, not a real npm
  publish. Tagging and publishing still require a maintainer commit on `main`,
  `git tag v0.225.0`, and the GitHub `release.yml` workflow.

## 2026-06-02 — Full-Site Availability Sweep and Browser Substrate Repair

- Root cause: commit `7f1a1efc` introduced browser bridge port isolation that
  could trust an incompatible extension hello. Commit `c43cb7dc` then broadened
  repair behavior while doctor output could mask the bad daemon/extension state.
- Added `scripts/site-availability-sweep.ts` and `npm run site:availability`.
  The sweep classifies every adapter command, then runs at most one safe
  public/read/non-browser/no-free-input representative probe per site.
- Extracted shared health classifiers into `scripts/adapter-health-shared.ts`
  so `adapter:health` and the new site sweep agree on detect gates,
  platform/capability gates, transient network/rate-limit/auth/local-daemon
  deferrals, and probe args.
- Fixed concentrated sweep failures:
  - untyped `limit` probe args now match CLI string semantics;
  - Electron desktop and AI-chat/app-specific commands now expose
    `minimum_capability: cdp-browser.cdp_attach`;
  - local WebSocket commands are environment-gated via `net.websocket`;
  - optional semantic inputs such as `query`, `author`, `pid`, `id`, `url`, and
    `tags` are classified as input-required rather than empty-probed;
  - Chrome/Electron launchers now convert detached `spawn` errors into
    catchable launch errors and verify mdfind-discovered app executables.
- Final full-site sweep result:
  `SITE_SWEEP_TIMEOUT_MS=10000 npx tsx scripts/site-availability-sweep.ts` —
  exit 0. 313 sites, 1784 adapter commands classified; site statuses:
  ok=62, environment_skip=13, no_auto_probe=238, fail=0.
- Experiment ladder: targeted site-sweep/Electron/launcher tests, typecheck,
  lint, full unit tests, adapter health, real E2E, format check, and a final
  post-format full-site sweep.
- Observed verification:
  - `npm test` — 238 files, 2691 passed, 2 skipped.
  - `npm run adapter:health` — ok=155, fail=0, skip=1629,
    skip_env_missing=65, total=1784.
  - `npm run e2e:real` — workflow_total=44, passed=43, failed=0, skipped=1
    (`arxiv` rate limited).
  - Common social smoke through built `dist/main.js`: `twitter tweets
kalomaze`, `xiaohongshu feed`, `reddit user-posts spez`, `youtube search
openai`, `bilibili trending`, and `weibo trending` each returned
    `ok=true` with one row.
  - Final sweep environment skips were 5 auth-gated sites, 5 loopback/private
    local services, 2 deprecated upstream patent placeholders, and 1 transient
    V2EX timeout.
- Residual risk: this proves every safe automatically runnable site
  representative on this host. It intentionally does not claim auth-only,
  browser-only, write/destructive, quarantined, platform-missing, local-daemon,
  or caller-input-required commands are live without credentials, UI/CDP state,
  explicit user input, or a safe write sandbox.

## 2026-06-02 — 0.225.1 Browser Fresh-Target Release Closed

- Root cause: the user-session CDP acquisition path treated a reachable
  `/json` endpoint as enough proof that the existing page target was healthy.
  The loaded-extension automation Chrome on port 9223 still answered HTTP CDP
  discovery, but its existing page target timed out on `Runtime.evaluate`,
  `Page.enable`, and `Page.addScriptToEvaluateOnNewDocument`; a fresh
  `/json/new?about:blank` target on the same browser completed those commands.
- Fix: `connectToChrome` now supports a `freshPage` connection mode,
  `BrowserPage.connect` passes that mode through, and user-session browser
  pipeline acquisition always attaches to a fresh page target. Fresh-target
  `Page.enable` failure is fatal instead of being silently tolerated.
- Additional release fixes: added `xiaohongshu feed`, locked the Maoyan hot
  JSON path to `movieList.list`, shared the adapter-health classifier with the
  full-site sweep, improved E2E timeout diagnostics, and prepared
  `0.225.1 — Apollo · Conrad` docs/package metadata.
- Final availability evidence:
  `SITE_SWEEP_TIMEOUT_MS=10000 npm run --silent site:availability` — exit 0;
  site statuses: ok=64, environment_skip=12, no_auto_probe=237, fail=0.
  `npm run adapter:health` — exit 0; ok=158, fail=0, skip=1626,
  skip_env_missing=66, total=1784.
- Final real E2E evidence:
  `npm run e2e:real` — exit 0; catalog_total=1820, workflow_total=44,
  workflow_passed=44, workflow_failed=0, workflow_skipped=0.
- Final release evidence:
  `npm run verify` — exit 0. Unit tests: 239 files, 2693 passed, 2 skipped.
  Adapter tests: 168 files, 6426 passed. Perf, compute coverage, adapter-test
  coverage, stats, conformance, exports, changesets, and boundary checks also
  passed. `npm run release:check -- --strict-codename` passed 23/23.
  `npm publish --dry-run` produced the `@zenalexa/unicli@0.225.1` dry-run
  tarball (`zenalexa-unicli-0.225.1.tgz`), package size 2.7 MB, 3828 files.
- Common site smoke through built `dist/main.js`: `twitter tweets kalomaze`,
  `xiaohongshu feed`, `reddit user-posts spez`, `youtube search openai`,
  `bilibili trending`, `weibo trending`, and `maoyan hot` each returned
  `ok=true` with one row and no stderr.
- Residual risk: this proves the browser substrate regression and all safe
  representative probes on this host. It still intentionally does not claim
  write/destructive, browser-only manual flows, auth-only commands without
  usable cookies, quarantined commands, platform-missing commands, or commands
  requiring caller-supplied semantic input.

## 2026-06-27 — arXiv Source-Level Full-Text Read

- Root cause: arXiv exposed `scholar.get` and `scholar.pdf`, but not
  `scholar.fulltext`, so `unicli scholar read --source arxiv` could not prove a
  source-direct reading path before falling back to generic PDF artifacts.
- Added `arxiv read` in `src/adapters/arxiv/papers.ts`: normalizes modern and
  legacy arXiv IDs/URLs, fetches the source Atom record, downloads the PDF,
  extracts page-bounded text through `pdftotext`, labels `text_source=pdf`, and
  returns source URL, PDF URL, local path, truncation metadata, and authors.
- Added command-resource metadata `executables: ["pdftotext"]` and threaded the
  field through TS/YAML manifest generation, runtime registry, fast-path
  operation policy, kernel authorization, and command contracts. This fixed the
  `describe arxiv read` governance scope from an imprecise `process:arxiv` to
  the actual local process `process:pdftotext`.
- Experiment ladder:
  - `npm run test:adapter -- src/adapters/arxiv/papers.test.ts`
  - `npx vitest run tests/unit/manifest-ts-scan.test.ts tests/unit/operation-policy.test.ts tests/unit/command-contract.test.ts`
  - `npm run typecheck`, `npm run lint`, `npm run lint:adapters`,
    `npm run lint:schema-v2`
  - `npm run build`
  - `node dist/main.js -f json describe arxiv read`
  - `node dist/main.js -f json scholar coverage --sources arxiv`
  - `node dist/main.js -f json arxiv read 1706.03762 --first-page 1 --last-page 1 --max-chars 2000 --output ./.tmp/unicli-dist-arxiv-read-smoke`
  - `node dist/main.js -f json scholar read 1706.03762 --source arxiv --first-page 1 --last-page 1 --max-chars 2000 --output ./.tmp/unicli-dist-scholar-arxiv-read-smoke`
  - `npm run verify`
- Observed result: arXiv coverage now reports `has_fulltext=true`,
  `read_strategy=source-fulltext-then-pdf`, `next_fulltext=unicli arxiv read
<id-or-ref>`, and `coverage_score=6/11`. Built `arxiv read` and built
  `scholar read --source arxiv` both downloaded the paper PDF and extracted
  5,188 characters from page 1 of `1706.03762`, truncated to the requested
  2,000 characters. Full `npm run verify` passed: unit tests passed 241 files /
  2,790 tests / 2 skipped; adapter tests passed 169 files / 6,460 tests; perf,
  compute coverage, adapter-test coverage, stats, conformance, exports,
  changesets, and boundary checks also passed.
- Fail-closed observation: a first live smoke using `/tmp/...` was rejected by
  path hardening because output paths must remain inside the repo or `$HOME`.
  Re-running with `./.tmp/...` passed without relaxing validation.
- Generated artifacts: `dist/manifest.json`, `dist/manifest-compact.txt`,
  `stats.json`, README/doc stats, and AGENTS adapter counts were regenerated;
  command count is now 1,791 and test count is now 9,250.
- Residual risk: this is PDF-derived text, not arXiv TeX/HTML structural parse;
  citation/reference graph, code/project, datasets/models/spaces, and
  peer-review coverage for arXiv remain separate scholarly closed-loop gaps.
