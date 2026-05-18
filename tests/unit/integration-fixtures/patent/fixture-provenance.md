# Patent fixture provenance

This file records, per fixture, whether the bytes were captured from a live
call or constructed from the upstream's published schema. The contract
introduced by subagent E (2026-05-18) is:

- `live-recorded YYYY-MM-DD` — the response was actually fetched against
  the upstream endpoint on that date and saved verbatim; the only
  permissible edits are bytewise redaction of secrets.
- `synthetic-shape-only — recorded shape from <doc-url> <YYYY-MM-DD>` —
  no live call was made; the fixture mirrors the documented response
  schema from the named upstream documentation URL, with placeholder
  values for every datum.

This split exists because **claiming a fixture is "live-recorded" when it is
not** is the kind of dishonesty rule 00-no-hacks forbids. A live-recorded
fixture pins the upstream's actual byte shape on a date; a synthetic-only
fixture only pins our normaliser's expected input contract. Reviewers should
treat the two differently:

- For `live-recorded`: a schema drift between fixture and current upstream
  is a real upstream change, surface it as a finding.
- For `synthetic-shape-only`: a schema drift between fixture and current
  upstream is a local-only assumption that may already be wrong; the next
  live verification (when a key arrives) is the authoritative pin.

## Fixture inventory

### `fixtures/uspto-search.json`

Provenance: `synthetic-shape-only — recorded shape from data.uspto.gov/swagger 2026-05-18`

The USPTO Open Data Portal's published OpenAPI document declares the
`patentFileWrapperDataBag` array of objects, each carrying
`applicationNumberText` and an `applicationMetaData` block with
`earliestPublicationNumber`, `inventionTitle`, `filingDate`,
`earliestPublicationDate`, and `grantDate`. The fixture is one row,
populated with values that exercise each field. No live call was made
during this session because `USPTO_ODP_API_KEY` was not present in the
test environment; future maintainers with a key can replace this with a
real recorded response by saving the JSON output of:

```
curl -H "X-API-KEY: $USPTO_ODP_API_KEY" \
     "https://api.uspto.gov/api/v1/patent/applications/search?q=optical&limit=1"
```

Wave-2 enrichments (2026-05-18, this session): the fixture was extended to
include `applicationMetaData.abstractText`,
`applicationMetaData.applicationStatusDescriptionText`,
`applicationMetaData.inventorBag[]` (with `firstName` / `lastName` /
`inventorNameText` / `countryCode`), `applicationMetaData.applicantBag[]`,
and `applicationMetaData.cpcClassificationBag[]`. Each field name is
sourced from data.uspto.gov/swagger v1; this is still synthetic-shape-only
because no live key was present. The contract surfaced in
`uspto.fixture.test.ts` is that the normaliser preserves every field
verbatim; the contract surfaced in `src/adapters/uspto/{search,get}.yaml`
is that the map step extracts each field from the documented ODP path.

### `fixtures/epo-search.xml`

Provenance: `synthetic-shape-only — recorded shape from docs.epo.org/3.2/api 2026-05-18`

EPO OPS returns St.36 XML containing `<ops:exchange-document>` elements
with nested `<bibliographic-data>` carrying `<publication-reference>`,
`<invention-title>`, and `<application-reference>`. The fixture is a
minimal but namespace-correct slice that the `select-xml` step can walk;
because the step is generic over XPath rather than EPO-specific, the
fixture stays small.

Wave-2 enrichments (2026-05-18, this session): the fixture was extended to
include `parties.inventors.inventor[]` with `inventor-name.name`,
`parties.applicants.applicant[]` with `applicant-name.name`,
`classifications-ipcr.classification-ipcr[].text` (IPC),
`patent-classifications.patent-classification[]` (CPC tree),
`priority-claims.priority-claim[].document-id.date`, the `@family-id`
attribute on `<ops:exchange-document>`, and an `<abstract lang="en">`
block. Each path is documented in the OPS v3.2 DOCDB schema
(docs.epo.org). Still synthetic-shape-only — no live OAuth2 token was
present during this session.

### `fixtures/pqai-prior-art.json`

Provenance: `synthetic-shape-only — recorded shape from projectpq.ai/about/api 2026-05-18`

PQAI's `/search/102` endpoint returns a JSON envelope with a `results`
array; each entry carries `patent_id`, `title`, `abstract`, and a similarity
score. The fixture exercises the normaliser's handling of PQAI's compact
publication-number format (no kind code) and confirms the prior-art path
can still produce a canonical PatentRecord when only the bare minimum
fields are present.

Wave-2 enrichments (2026-05-18, this session): the fixture rows were
extended with `publication_date`, `filing_date`, and `kind_code` so the
adapter's enriched map step has every field to extract; the `score` field
was already present and is now surfaced via `PatentRecord.relevance_score`
through the meta-command's `coerceToPatentRecords`. Still
synthetic-shape-only — no live `PQAI_API_TOKEN` was present.
