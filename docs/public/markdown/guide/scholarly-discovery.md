<!-- Generated from docs/guide/scholarly-discovery.md. Do not edit this copy directly. -->

# Trace Scholarly Work

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/scholarly-discovery
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/scholarly-discovery.md
- Section: Use Uni-CLI
- Parent: Use Uni-CLI (/guide/)

Uni-CLI treats a paper as a set of linked records. A DOI can lead to publisher metadata, an official conference program, an award marker, an OpenReview forum, a PDF, code, and research data. Each returned relationship keeps its own source URL.

## Start with one reference

Use a DOI, an exact title, an arXiv identifier, a PMID, or an OpenReview forum URL.

```bash
unicli scholar trace 10.1145/3772318.3791239 -D
unicli scholar trace "Attention Is All You Need" -D
```

`scholar trace` resolves the bibliographic anchor, searches OpenReview by the resolved title, checks official program context when the venue can be identified, and queries code and dataset sources. Resource rows retain their source attribution, relationship evidence, and candidate status.

An explicit venue and year constrain the bibliographic anchor before relationships are joined. When the anchor already contains an OpenReview forum identifier, the trace reuses it directly for reviews and rebuttals. Title-based resource discovery keeps exact paper-title matches so a similarly named repository cannot enter the trace.

Use a venue override when publisher metadata uses a long proceedings title.

```bash
unicli scholar trace 10.1145/3772318.3791239 \
  --venue CHI \
  --year 2026 \
  -D
```

## Resolve the current CCF A directory

The bundled CCF directory follows the formal seventh-edition PDF published in 2026 and its April 9 correction. It contains all 58 A-class conferences across ten fields. Each record retains the PDF page, source URL, official venue link, publisher, former names, and aliases.

```bash
unicli ccf conferences
unicli ccf conferences --publisher USENIX
unicli ccf conference ICLR
unicli ccf conference "USENIX ATC"
```

The former name `USENIX ATC` resolves to `ACM SIGOPS ATC`. A lookup for `IJCAI` returns a structured `empty_result` because the formal seventh edition no longer lists it as A class.

## Search one venue and year

Use `scholar venue` for proceedings lookup across venue-aware sources. CCF acronyms and former names are resolved before source selection. ACM and IEEE sources are both eligible because DOI registration can change by year or differ from a directory publisher label. Exact venue and year checks remove nearby acronyms and records from another edition. A year inside the positional venue, such as `PPoPP 2025`, is parsed when `--year` is absent.

```bash
unicli scholar venue FAST --year 2025
unicli scholar venue FOCS --year 2024
unicli scholar venue CAV --year 2024
unicli scholar venue FM --year 2024
unicli scholar search "program synthesis" --venue PLDI --year 2025
```

DBLP supplies proceedings for CCF venues whose publisher does not expose a suitable paper API, including Springer-backed CAV and FM. When a volume is published in a later calendar year, Uni-CLI reports the conference year in `year` and retains the deposit year in `publication_year`.

FAST, NSDI, OSDI, USENIX Security, and the former USENIX ATC series have a first-party USENIX adapter. It reads official technical-session pages and fetches presentation metadata. A PDF is returned only when the official page exposes `citation_pdf_url`.

```bash
unicli usenix venue FAST --year 2025
unicli usenix awards FAST --year 2025
unicli usenix paper "https://www.usenix.org/conference/fast25/presentation/liu-jing"
```

AAAI main-track papers come from the official AAAI proceedings site. OOPSLA, POPL, PLDI, and ICFP use a PACMPL-aware view that retains volume and issue identity. OOPSLA uses the legacy issue through 2021 and the OOPSLA1 and OOPSLA2 issues from 2022. FSE 2024 and later resolve through PACMSE. SIGMOD 2023 and later resolve the PACMMOD issues listed by the official conference paper index, including issues published in the preceding calendar year. SIGGRAPH resolves through the main-conference issue of ACM Transactions on Graphics. VLDB resolves through Proceedings of the VLDB Endowment. Direct `PACMPL`, `PACMSE`, `PACMMOD`, `PVLDB`, and `VLDB` venue queries list the corresponding journal contents without being confused with a conference acronym.

```bash
unicli aaai papers --year 2025 --limit 20
unicli scholar venue AAAI --year 2025
unicli pacmpl venue OOPSLA --year 2024
unicli pacmpl venue OOPSLA2 --year 2024
unicli acm venue FSE --year 2024
unicli acm venue SIGMOD --year 2025
unicli acm venue SIGGRAPH --year 2024
unicli scholar venue PACMSE --year 2024
unicli scholar venue VLDB --year 2025
unicli scholar venue "PPoPP 2025"
```

`scholar search` extracts a CCF conference and year from the free-form query when possible. It removes proceedings front matter and applies final venue and year checks. A miss can trigger one bounded spelling-recovery pass. Corrected tokens appear in `query_corrections`, while `search_query` records the executed query.

```bash
unicli scholar search "PPoPP 2025 parallel programming"
unicli scholar search "Budget Recyling Diferential Privcy" \
  --sources ieee,crossref \
  -D
```

Search and venue fan-out use a 20-second source deadline by default. PDF, resource, and availability collectors run independent sources concurrently. OpenReview requests and retry waits honor caller cancellation and a bounded request deadline. The `--timeout` option changes the scholar deadline for slow or restricted networks.

```bash
unicli scholar venue FAST --year 2025 --timeout 30
```

## Read reviews and rebuttals

The trace output marks an OpenReview match as `peer-review-thread`. Its `next_command` calls the review reader with the forum identifier.

```bash
unicli scholar reviews abcDEF123 -D
```

The review reader returns reviews, author responses, decisions, meta-reviews, and public comments as separate chronological rows when the forum exposes them.

## Find official awards

SIGCHI conference programs expose award markers beside paper identifiers and ACM DOI links. Official ICLR announcements link each award paper directly to its OpenReview forum, review history, rebuttal, and PDF.

```bash
unicli scholar awards CHI --year 2026
unicli sigchi awards CHI --year 2026 --award best-paper
unicli sigchi papers UIST --year 2025 --query "interaction"
unicli scholar awards ICLR --year 2025
unicli iclr awards ICLR --year 2025 --award outstanding-paper
unicli scholar trace "https://openreview.net/forum?id=6Mxhg9PtDE" \
  --venue "ICLR 2025" \
  --year 2025 \
  -D
```

An award row keeps the official program or announcement URL. A SIGCHI DOI continues through publisher and artifact sources. An ICLR forum identifier continues through OpenReview reviews, author responses, decisions, and PDF access.

## Search ACM and IEEE

ACM and IEEE DOI deposits provide keyless publisher-scoped discovery through Crossref. IEEE Xplore adds article numbers, access state, citation counts, conference details, and publisher PDF links when an API key is configured.

```bash
unicli acm search "accessible interaction" --year 2026
unicli acm venue "CHI Conference" --year 2026
unicli ieee search "human robot interaction" --year 2025

export IEEE_XPLORE_API_KEY="..."
unicli ieee-xplore search "human robot interaction" --year 2025
```

`unicli ieee search` remains available without a key. `unicli ieee-xplore search` uses the official IEEE Metadata API and returns a structured `config_error` when its key is absent.

## Find datasets and software

DataCite records connect publication DOIs with registered datasets and software. Hugging Face and paper resource adapters add models, Spaces, and project pages. The GitHub scholarly adapter searches repository metadata and README files for DOI or strong title evidence.

```bash
unicli datacite search "benchmark dataset" --type Dataset
unicli datacite related 10.1145/3772318.3791239
unicli scholar datasets 10.1145/3772318.3791239 -D
unicli scholar code 10.1145/3772318.3791239 -D
```

GitHub matches remain candidates until stronger ownership evidence exists. Each row reports `relationship`, `verification`, `match_type`, `confidence`, and the URL or excerpt that supports the match. `is_official_code` stays false for a search-derived candidate. `scholar trace` includes these source-attributed code and dataset relationships in the same graph as publisher, review, award, and PDF records.

```bash
unicli github-scholar search \
  --doi 10.1145/3718958.3754348 \
  --title "Raha" \
  --limit 10
```

## Identity and joining rules

The resolver prefers DOI, then arXiv, PMID, OpenReview, and source-local identifiers. Exact normalized title, year, and author overlap provide a bounded fallback when identifiers are missing. Every relationship retains `source_adapter`, `source_url`, and `retrieved_at`.

Award claims require an official conference or society source. Review claims require the review platform thread. PDF and open-access claims require a provider URL that can be inspected independently.

## Resource landscape

The shipped source set covers general graphs, major computer science proceedings, preprints, medicine, Chinese literature search, review platforms, open-access lookup, artifacts, and local reference libraries. `unicli scholar coverage --sources all -D` reports the live command surface.

The next connector groups are part of the scholarly adapter requirements. A connector can ship when it has a stable source identity, explicit authentication behavior, normalized records, actionable failures, and a real lookup test.

| Resource family              | Shipped sources                                                                                                      | Connector requirements                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| DOI and citation graphs      | Crossref, DataCite, OpenAlex, Semantic Scholar, DBLP                                                                 | OpenAIRE Graph, CORE, Wikidata scholarly records, Lens, Dimensions, Scopus, Web of Science                                         |
| Open review                  | OpenReview                                                                                                           | Conference-hosted review systems, journal peer-review histories, review attachments, decision revisions                            |
| Computer science proceedings | AAAI, ACM, PACMPL, PACMSE, PACMMOD, SIGCHI, ICLR, IEEE, IEEE Xplore, USENIX, ACL Anthology, CVF, PMLR, NeurIPS, DBLP | JMLR, Dagstuhl, LIPIcs, CEUR-WS, Springer proceedings                                                                              |
| Preprints and repositories   | arXiv, bioRxiv, medRxiv                                                                                              | HAL, SSRN, OSF Preprints, ChemRxiv, Research Square, RePEc, EconPapers                                                             |
| Medicine and life sciences   | PubMed, PMC links, bioRxiv, medRxiv                                                                                  | Europe PMC, ClinicalTrials.gov, WHO ICTRP, Cochrane, Crossmark corrections                                                         |
| Journals and books           | Crossref publisher metadata, Google Scholar, Baidu Scholar, CNKI, Wanfang                                            | DOAJ, JSTOR, Project MUSE, Open Library, HathiTrust, Springer Nature, Elsevier, Wiley, Taylor and Francis, Sage, Oxford, Cambridge |
| Researchers and institutions | Author records from OpenAlex, Semantic Scholar, DBLP, OpenReview, PubMed                                             | ORCID, ROR, Wikidata, Open Funder Registry, national researcher registries                                                         |
| Data and software            | DataCite, Hugging Face resources, verified GitHub candidates                                                         | Zenodo, Figshare, Dryad, Dataverse, OSF, Software Heritage, GitLab, institutional repositories                                     |
| Domain indexes               | PubMed, ACL, CVF, PMLR, NeurIPS                                                                                      | NASA ADS, INSPIRE, zbMATH Open, MathSciNet, ERIC, AGRICOLA, GeoRef, PhilPapers                                                     |
| Awards and announcements     | SIGCHI and USENIX official programs, ICLR official announcements                                                     | ACM award pages, IEEE society awards, conference newsrooms, society feeds, correction and retraction notices                       |
| Personal libraries           | Zotero                                                                                                               | BibTeX libraries, CSL JSON, EndNote XML, RIS, local PDF collections                                                                |

Paid and institution-licensed sources remain explicit. Their adapters must report the required key, subscription, or browser session and must not hide a restricted result behind an empty response.

## Primary API contracts

Adapter work tracks the provider contract or the official public artifact listed here.

| Provider          | Primary contract                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Crossref          | [REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)                  |
| DataCite          | [REST API](https://support.datacite.org/docs/api)                                               |
| OpenAlex          | [API documentation](https://docs.openalex.org/)                                                 |
| Semantic Scholar  | [Academic Graph API](https://www.semanticscholar.org/product/api)                               |
| IEEE Xplore       | [API portal](https://developer.ieee.org/)                                                       |
| OpenReview        | [API documentation](https://docs.openreview.net/)                                               |
| ICLR              | [Official Blog WordPress API](https://blog.iclr.cc/wp-json/wp/v2/posts)                         |
| CCF               | [Official recommended directory](https://www.ccf.org.cn/Academic_Evaluation/By_category/)       |
| USENIX            | [Official conference proceedings](https://www.usenix.org/conferences/byname/108)                |
| AAAI              | [Official proceedings](https://ojs.aaai.org/index.php/AAAI)                                     |
| PACMPL            | [Crossref journal records](https://api.crossref.org/journals/2475-1421/works)                   |
| PACMSE            | [Crossref journal records](https://api.crossref.org/journals/2994-970X/works)                   |
| PACMMOD           | [Crossref journal records](https://api.crossref.org/journals/2836-6573/works)                   |
| ACM TOG           | [Crossref journal records](https://api.crossref.org/journals/0730-0301/works)                   |
| SIGMOD            | [Official accepted papers](https://2026.sigmod.org/sigmod_papers.shtml)                         |
| GitHub            | [REST API](https://docs.github.com/en/rest)                                                     |
| Datamuse          | [Word-finding API](https://www.datamuse.com/api/)                                               |
| ACL Anthology     | [API documentation](https://aclanthology.org/info/api/)                                         |
| DBLP              | [Search API documentation](https://dblp.org/faq/How+to+use+the+dblp+search+API.html)            |
| OpenAIRE          | [Graph API](https://graph.openaire.eu/develop/api.html)                                         |
| CORE              | [API documentation](https://core.ac.uk/services/api)                                            |
| Europe PMC        | [REST service](https://europepmc.org/RestfulWebService)                                         |
| ORCID             | [Public API guide](https://info.orcid.org/documentation/integration-guide/orcid-api-tutorials/) |
| ROR               | [REST API](https://ror.readme.io/docs/rest-api)                                                 |
| Software Heritage | [Web API](https://archive.softwareheritage.org/api/)                                            |

## Adapter contract

Each scholarly connector should expose the smallest useful subset of these capabilities.

| Capability           | Returned evidence                                     |
| -------------------- | ----------------------------------------------------- |
| `scholar.search`     | Ranked work records with source identity              |
| `scholar.get`        | One bibliographic record by a stable identifier       |
| `scholar.pdf`        | A source-backed PDF candidate                         |
| `scholar.fulltext`   | Source-readable full text                             |
| `scholar.review`     | Reviews, rebuttals, decisions, and comments           |
| `scholar.venue`      | Proceedings or venue contents                         |
| `scholar.awards`     | Official award records                                |
| `scholar.context`    | Program, announcement, correction, or related context |
| `scholar.citations`  | Works that cite the anchor                            |
| `scholar.references` | Works cited by the anchor                             |
| `scholar.code`       | Software and project links                            |
| `scholar.datasets`   | Data, models, and related research objects            |

Use `unicli search "<academic intent>"` before selecting a connector. Use `unicli scholar doctor --sources all --live` for current source health.
