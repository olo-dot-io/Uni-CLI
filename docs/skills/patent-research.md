---
name: patent-research
description: >
  Patent search, retrieval, family lookup, and prior-art workflows across
  global patent offices and aggregators through the `unicli patent`
  meta-command. Trigger when an agent needs to search USPTO / EPO / JPO /
  KIPRIS / DPMA / INPI / IP Australia / Lens / Google Patents / PQAI /
  PatSnap; when a user pastes a patent publication number or CPC code and
  asks for related records; when the task is prior-art discovery against
  a candidate abstract; or when the user says "find patents on", "patent
  family", "prior art", "查专利", "专利族".
version: 0.221.0
category: research
depends-on:
  - unicli
  - talk-normal
allowed-tools: [Bash, Read]
protocol: 2.0
triggers:
  - "unicli patent"
  - "find patents"
  - "patent search"
  - "patent family"
  - "prior art"
  - "publication number"
  - "查专利"
  - "专利族"
  - "申请号"
---

# Uni-CLI Patent Research

The `unicli patent` meta-command fans out search, retrieval, family lookup,
legal-status, and prior-art queries across every registered patent adapter,
normalises every result to a single `PatentRecord` shape, and dedupes by
patent family. Each adapter is an agent-readable YAML pipeline; structured
error envelopes carry actionable suggestions when an adapter is missing
credentials or upstream returns an unexpected shape.

**Install** (once): `npm install -g @zenalexa/unicli`

> **No API key? Start here.** See [docs/skills/patent-cookbook.md](./patent-cookbook.md)
> for copy-pastable recipes that run on day zero against keyless web adapters
> (`google-patents-web`, `freepatentsonline-web`) with no credential setup.

---

## TL;DR

- `unicli patent search "<query>"` — fan-out across default sources (USPTO, EPO, JPO) with reciprocal-rank fusion.
- `unicli patent search "<query>" --sources google-patents-web,freepatentsonline-web` — keyless day-zero search; no API key, no Chrome.
- `unicli patent get <publication-number>` — route by ST.16 country prefix (US, EP, JP, KR, CN, DE, FR, GB, CA, AU, BR, RU).
- `unicli patent prior-art --abstract "<text>"` — semantic + keyword + CPC fusion across PQAI, Google Patents BigQuery, and EPO.

---

## Day-zero with no key

The `google-patents-web` and `freepatentsonline-web` adapters require **zero
credentials and zero browser session**. They hit the public XHR endpoint that
drives `patents.google.com` and the SSR listing pages on
`www.freepatentsonline.com` directly with a real-browser `User-Agent`. Use them
as the first thing you try when a fresh user wants results before configuring
any API keys.

```
unicli patent search "<query>" --sources google-patents-web,freepatentsonline-web --limit 10
```

Both adapters emit canonical `PatentRecord` rows that flow through the same
fan-out and dedupe logic the rest of the vertical uses. When Google's anti-bot
gate kicks in (HTTP 503), the meta-command transparently falls through to
FreePatentsOnline. Detailed recipes are in
[docs/skills/patent-cookbook.md](./patent-cookbook.md).

---

## When to use this skill

Use this skill when:

- An agent needs structured patent metadata (publication number, title, inventors, assignees, dates, family ID, legal status) rather than a raw HTML page.
- A user provides a publication number and wants the cross-jurisdiction family.
- A draft abstract or claim needs a prior-art sweep before filing.
- An audit needs `legal_status` for a batch of publication numbers across multiple offices.
- A workflow needs a single deduped result list rather than one per office.

Do not use this skill for general web search, single-site browsing, or
non-patent intellectual-property records (trademarks, designs); those have
their own adapters.

---

## Setup

Each office has its own credential channel. Both forms below are accepted:
environment variable (highest precedence) and `~/.unicli/auth/<site>.json`
fallback (managed by `unicli auth setup <site>`).

| Site                | Env var                                      | Auth file                         | How to obtain                                                                                                   |
| ------------------- | -------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `uspto`             | `USPTO_ODP_API_KEY`                          | `~/.unicli/auth/uspto.json`       | Free key at developer.uspto.gov (Open Data Portal).                                                             |
| `epo`               | `EPO_OPS_CLIENT_ID`, `EPO_OPS_CLIENT_SECRET` | `~/.unicli/auth/epo.json`         | Free tier (4 GB / week) at developers.epo.org; OAuth2 client_credentials.                                       |
| `jpo`               | `JPO_API_TOKEN`                              | `~/.unicli/auth/jpo.json`         | Email application to `PA0630@jpo.go.jp`; quotas relaxed 2026-03.                                                |
| `kipris`            | `KIPRIS_ACCESS_KEY`                          | `~/.unicli/auth/kipris.json`      | Free registration at plus.kipris.or.kr.                                                                         |
| `inpi-fr`           | (none — public subset)                       | n/a                               | data.inpi.fr open subset; full records require session-cookie login (not yet implemented).                      |
| `dpma`              | `DPMA_AUTHORIZATION`                         | `~/.unicli/auth/dpma.json`        | Paid DPMAconnectPlus contract (~EUR 200 setup); precompute `Basic $(printf '%s:%s' "$USER" "$PASS" \| base64)`. |
| `ipaustralia`       | `IPAUSTRALIA_API_KEY`                        | `~/.unicli/auth/ipaustralia.json` | Free registration at api.ipaustralia.gov.au.                                                                    |
| `lens`              | `LENS_API_TOKEN`                             | `~/.unicli/auth/lens.json`        | Institutional Lens Toolkit subscription required.                                                               |
| `google-patents-bq` | `GCLOUD_ACCESS_TOKEN`                        | n/a                               | `gcloud auth application-default print-access-token`; BigQuery sandbox is 10 GB / month free.                   |
| `pqai`              | `PQAI_API_KEY`                               | `~/.unicli/auth/pqai.json`        | USD 20 / month individual tier (1,500 calls).                                                                   |
| `patsnap`           | `PATSNAP_API_KEY`                            | `~/.unicli/auth/patsnap.json`     | Starter free tier (10K credits / 90 days); paid plans from USD 100.                                             |
| `wipo-patentscope`  | (none — placeholder)                         | n/a                               | SOAP web service requires subscription; adapter emits `PATENT_API_DEPRECATED`.                                  |
| `ukipo`             | (none — placeholder)                         | n/a                               | Ipsum retired 2025-01; OneIPO API on 2026 roadmap; adapter emits `PATENT_API_DEPRECATED`.                       |

---

## Command surface

| Command                                 | Example                                                                 | Notes                                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `search <query>`                        | `unicli patent search "lithium battery" --sources uspto,epo --limit 30` | Fans out across sources, applies reciprocal-rank fusion, dedupes by family. `--sources all` opts in to every registered adapter. |
| `get <publication-number>`              | `unicli patent get US-20240123456-A1`                                   | Routes to the home office by ST.16 prefix; falls back to Espacenet for unknown jurisdictions.                                    |
| `family <publication-number>`           | `unicli patent family EP-3000000-A1`                                    | Brokered through EPO Espacenet (INPADOC family); falls back to the home office on broker failure.                                |
| `citations <publication-number>`        | `unicli patent citations US-9999999-B2 --direction citing`              | `--direction citing` (records that cite this) or `cited` (records this cites).                                                   |
| `legal-status <publication-numbers...>` | `unicli patent legal-status US-1-A1 EP-2-A1`                            | Batched by jurisdiction; one call per home office.                                                                               |
| `prior-art`                             | `unicli patent prior-art --abstract "A method for…" --top 20`           | Default sources PQAI, Google Patents BigQuery, EPO; rank-fused.                                                                  |
| `doctor`                                | `unicli patent doctor`                                                  | Probes each registered patent adapter for health and reports per-source status.                                                  |

Add `-f json` to any command to receive a machine-readable envelope on stdout
and structured error JSON on stderr. The output schema is documented under
`docs/RECIPES.md#agent-envelope`.

---

## Source selection

The default `search` source list is `uspto,epo,jpo` — three free-tier sources
that cover the largest fraction of global filings. Override with `--sources`:

- L0 (free, no key): `inpi-fr` (open subset), `wipo-patentscope` / `ukipo` (placeholders).
- L1 (free with registered key): `uspto`, `epo`, `jpo`, `kipris`, `ipaustralia`, `google-patents-bq`.
- L2 (paid subscription): `dpma`, `lens`, `patsnap`, `pqai`.
- L3 (browser-driven, no API): future adapters for `cnipa`, `espacenet`, `cipo`, `inpi-br`, `fips`.

Pass `--sources all` to query every registered patent adapter; expect higher
latency and possible per-source rate limits.

---

## Failure modes and repair

Every patent adapter emits one of the following structured error codes on
stderr when it cannot return data. Each code is paired with a recommended
next action.

| Code                        | Exit | What it means                                                                 | What to do                                                                                           |
| --------------------------- | ---- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `PATENT_AUTH_REQUIRED`      | 77   | Adapter could not find a valid credential.                                    | Set the env var listed in the setup table, or run `unicli auth setup <site>`.                        |
| `PATENT_RATE_LIMIT`         | 75   | Upstream rate-limited the request.                                            | Retry with backoff; the envelope's `retryable` field will be `true`.                                 |
| `PATENT_NOT_FOUND`          | 66   | Query or publication number returned zero rows.                               | Verify the input, or widen `--sources`.                                                              |
| `PATENT_INVALID_NUMBER`     | 65   | Publication number has no recognised ST.16 country prefix.                    | Provide a CC-prefixed number (US, EP, JP, …).                                                        |
| `PATENT_REGION_BLOCKED`     | 77   | Office geofences the endpoint.                                                | Run from an allowed region, or use the browser-driven adapter (when shipped).                        |
| `PATENT_API_DEPRECATED`     | 69   | Adapter is a registry placeholder; upstream has no shipping API.              | Follow the suggestion's URL to subscribe or use the upstream web UI; check the office's API roadmap. |
| `PATENT_FAMILY_BROKER_DOWN` | 1    | EPO Espacenet family broker errored and the home-office fallback also failed. | Retry later or call `unicli patent doctor` to confirm the outage.                                    |
| `PATENT_BROWSER_CAPTCHA`    | 1    | Browser-driven adapter hit a captcha.                                         | Open the page manually, solve the captcha, and re-run.                                               |
| `PATENT_UNSUPPORTED_QUERY`  | 1    | Adapter cannot express a field in your query.                                 | Drop the field, or pick a different source.                                                          |
| `PATENT_SCHEMA_DRIFT`       | 1    | Upstream changed its response shape and a required field is missing.          | Run `unicli patent doctor`; file an adapter repair through `unicli repair <site> <command>`.         |

---

## Verification status per adapter

The `@verification` line in each adapter file header records whether the
adapter has been exercised against a live endpoint or whether it is gated
on credentials we do not maintain. Treat anything other than `verified` as
"compiles and lints; not yet end-to-end exercised in CI."

| Adapter             | Status                  | Note                                                                       |
| ------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `uspto`             | blocked-by-key          | Needs `USPTO_ODP_API_KEY` (free).                                          |
| `epo`               | blocked-by-key          | Needs `EPO_OPS_CLIENT_ID` / `EPO_OPS_CLIENT_SECRET` (free).                |
| `jpo`               | blocked-by-key          | Needs `JPO_API_TOKEN` (email application).                                 |
| `kipris`            | blocked-by-key          | Needs `KIPRIS_ACCESS_KEY` (free).                                          |
| `inpi-fr`           | blocked-by-key          | Open subset only; full records require session cookie not yet implemented. |
| `dpma`              | blocked-by-subscription | DPMAconnectPlus paid contract required.                                    |
| `ipaustralia`       | blocked-by-key          | Needs `IPAUSTRALIA_API_KEY` (free).                                        |
| `lens`              | blocked-by-subscription | Lens Toolkit institutional subscription.                                   |
| `google-patents-bq` | blocked-by-key          | Needs `GCLOUD_ACCESS_TOKEN`.                                               |
| `pqai`              | blocked-by-key          | USD 20 / month individual tier.                                            |
| `patsnap`           | blocked-by-subscription | Starter free 90 days; paid from USD 100.                                   |
| `wipo-patentscope`  | blocked-by-subscription | Registry placeholder; SOAP requires subscription.                          |
| `ukipo`             | waiting-for-api         | Registry placeholder; OneIPO API on 2026 roadmap.                          |

L3 browser-driven adapters (`cnipa`, `espacenet`, `cipo`, `inpi-br`, `fips`)
land in a follow-up; until then, the registry placeholders for `cnipa` and
`fips` (no public API) will route through the same `PATENT_API_DEPRECATED`
shape.

---

## End-to-end example: prior-art sweep

```bash
unicli patent prior-art \
  --abstract "A solid-state battery cathode using a sulfide electrolyte and a layered nickel-rich oxide active material, characterised by a sintered interface that suppresses interfacial resistance growth under cycling." \
  --sources pqai,google-patents-bq,epo \
  --top 20 \
  -f json \
  | jq '.results[] | {publication_number, title, source_adapter}'
```

What this does:

1. Submits the abstract to PQAI's semantic ranker, Google Patents BigQuery's text search, and EPO Espacenet's keyword search in parallel.
2. Normalises each result list to `PatentRecord` shape.
3. Reciprocal-rank fuses the three lists (Cormack/Clarke/Buettcher 2009, `k=60`).
4. Returns the top 20 fused candidates as a JSON envelope on stdout.

If any source emits a structured envelope (missing key, rate limit, schema
drift), the meta-command continues with the remaining sources and surfaces
the per-source error inside the final envelope's `suggestion` field.

---

## Public TypeScript surface

For third-party consumers building on top of `@zenalexa/unicli`, the patent
vertical's type contract is re-exported from `@zenalexa/unicli/index`:

```ts
import type {
  PatentRecord,
  PatentSearchQuery,
  PatentEnvelope,
  PatentErrorCode,
  PatentVerificationStatus,
} from "@zenalexa/unicli/index";
import {
  canonicalizePublicationNumber,
  dedupeByFamily,
} from "@zenalexa/unicli/index";
```

These names are part of the package's semver contract; additions are minor
versions, removals are major.

---

## See also

- `docs/ARCHITECTURE.md` — pipeline, transport, and registry architecture.
- `docs/ADAPTER-FORMAT.md` — adapter YAML schema and step reference.
- `skills/unicli-repair/SKILL.md` — repair loop when an adapter breaks.
- `docs/RECIPES.md` — agent-envelope JSON examples.
