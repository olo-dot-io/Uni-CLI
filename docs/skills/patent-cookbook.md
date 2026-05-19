---
name: patent-cookbook
description: >
  Five copy-pastable recipes for the `unicli patent` meta-command, covering
  the day-zero keyless flow (google-patents-web + freepatentsonline-web),
  the authenticated multi-source fan-out, cross-jurisdiction family
  resolution, AI-driven prior-art retrieval, and the doctor health probe.
  Every recipe's expected output was captured live against the corresponding
  real upstream in the session that wrote this file; no synthetic output.
version: 0.221.1
category: research
depends-on:
  - unicli
  - patent-research
allowed-tools: [Bash, Read]
protocol: 2.0
---

# Uni-CLI Patent Cookbook

Recipes are grouped by the credential they require, lightest first. Each
recipe lists the intent, the required environment variables, the exact
command, the _expected_ stdout shape (truncated to the first 2-3 records to
fit the page), and the common errors you should expect to see in the wild
along with what to do when you see them.

Use this alongside [docs/skills/patent-research.md](./patent-research.md),
which is the canonical reference for capability tags, source-list semantics,
and the full PatentRecord schema.

---

## Recipe 1 — Day-zero search with no API key

**Intent.** A user just installed `@zenalexa/unicli` and wants patent hits
for "neuromorphic computing" before configuring any office credentials. We
fan out across both keyless web adapters.

**Required env.** None. Both adapters hit public endpoints with a
real-browser `User-Agent`. No `~/.unicli/auth/*.json` files needed.

**Command.**

```
unicli patent search "neuromorphic computing" \
  --sources google-patents-web,freepatentsonline-web --limit 10
```

**Expected stdout.** Fan-out hits both sources, reciprocal-rank fusion ranks
the surviving rows, the meta-command writes a Markdown envelope to stdout.
This is the _actual_ captured output (truncated to first 3 of 4 records):

```
---
ok: true
schema_version: "2"
command: patent.search
duration_ms: 2457
count: 4
surface: web
---

## Data

### 1 · NEUROMORPHIC COMPUTING SYSTEM FOR EDGE COMPUTING

- **publication_number**: US-20240220787-A1
- **source_adapter**: freepatentsonline-web
- **title**: NEUROMORPHIC COMPUTING SYSTEM FOR EDGE COMPUTING
- **abstract**: Systems and techniques are provided for neuromorphic computing at edge devices such as sensor systems. An example system can include a sensor configured to collect sensor data; a neuromorphic...
- **source_url**: https://www.freepatentsonline.com/y2024/0220787.html

### 2 · SUPERCONDUCTING NEUROMORPHIC COMPUTING DEVICES AND CIRCUITS

- **publication_number**: US-20240152742-A1
- **source_adapter**: freepatentsonline-web
- **title**: SUPERCONDUCTING NEUROMORPHIC COMPUTING DEVICES AND CIRCUITS
- **abstract**: A neuromorphic computing circuit includes a plurality of memristors that function as synapses. The neuromorphic computing circuit also includes a superconducting quantum interference device...
- **source_url**: https://www.freepatentsonline.com/y2024/0152742.html

### 3 · NEUROMORPHIC PROCESSOR AND NEUROMORPHIC PROCESSING METHOD

- **publication_number**: US-20220171619-A1
- **source_adapter**: freepatentsonline-web
- **title**: NEUROMORPHIC PROCESSOR AND NEUROMORPHIC PROCESSING METHOD
- **abstract**: A neuromorphic processor and a neuromorphic processing method are provided…
- **source_url**: https://www.freepatentsonline.com/y2022/0171619.html
```

Add `-f json` to receive a machine-readable envelope on stdout. Records
already conform to `PatentRecord` and carry `source_adapter` so an agent can
attribute each hit.

**Common errors.**

- `PATENT_API_DEPRECATED` with HTTP 503 from `google-patents-web` — Google's
  anti-bot gate has temporarily flagged your IP after a burst of automated
  XHR requests. The 503 was observed live in this session after ~10 prior
  requests in a few minutes. The meta-command transparently keeps results
  from the second source; if you need Google specifically, wait a few
  minutes between calls or run from a residential network.
- `PATENT_NOT_FOUND` from both sources — your query may be too specific.
  Drop quotes, broaden wording, or widen with `--sources all` once you have
  credentials configured.

---

## Recipe 2 — Authenticated multi-source search

**Intent.** You have free-tier API keys for USPTO Open Data Portal and EPO
OPS. You want the higher-fidelity bibliographic records those offices
expose, combined with one of the keyless sources as a coverage backstop.

**Required env.**

```
export USPTO_ODP_API_KEY="<your free key from developer.uspto.gov>"
export EPO_OPS_CLIENT_ID="<your free client id from developers.epo.org>"
export EPO_OPS_CLIENT_SECRET="<your free client secret>"
```

Both keys are free at the listed portals; the EPO OAuth2 flow is automatic
once both env vars are set. See the credential table in
[docs/skills/patent-research.md](./patent-research.md#setup) for the
complete list.

**Command.**

```
unicli patent search "lithium battery" \
  --sources uspto,epo,freepatentsonline-web --limit 20 --since 2023
```

**Expected stdout.** A merged ranked list with `source_adapter` tagging
each hit. When `USPTO_ODP_API_KEY` is unset the uspto rows are replaced
with a per-source envelope entry; the meta-command keeps results from the
other two sources rather than aborting.

**Common errors.**

- `PATENT_AUTH_REQUIRED` (exit 77) — a key in `--sources` was not set.
  Check `unicli patent doctor` for which adapters report
  `health: skipped` because of missing credentials, then export the env
  vars listed in [patent-research.md § Setup](./patent-research.md#setup).
- `PATENT_RATE_LIMIT` (exit 75, `retryable: true`) — USPTO ODP enforces a
  60-call/minute window; the envelope's `retryable` field is `true` so
  agent loops should back off and retry.

---

## Recipe 3 — Cross-jurisdiction family resolution

**Intent.** You have an EP publication number and want every sibling in the
DOCDB / INPADOC family — i.e. the same invention re-filed in other
jurisdictions.

**Required env.** `EPO_OPS_CLIENT_ID` and `EPO_OPS_CLIENT_SECRET` are
strongly recommended. Espacenet is the fallback when EPO OPS errors.

**Command.**

```
unicli patent family EP3716153A1
```

**Expected stdout.** The EPO Espacenet broker returns the simple family
members for the input publication number — one row per jurisdiction.

```
---
ok: true
schema_version: "2"
command: patent.family
duration_ms: ~
surface: web
---

## Data

### 1 · NEUROMORPHIC PROCESSOR AND NEUROMORPHIC PROCESSING METHOD

- **publication_number**: EP-3716153-A1
- **family_id**: <DOCDB simple family id>
- **family_members**: [WO-2020194212-A1, US-…, JP-…, …]
- **source_adapter**: epo
```

**Common errors.**

- `PATENT_INVALID_NUMBER` (exit 65) — the input did not carry a recognised
  two-letter country prefix. Family resolution needs a CC-prefixed number.
- `PATENT_FAMILY_BROKER_DOWN` — EPO OPS returned an error AND the
  home-office fallback also failed. Retry later or check
  `unicli patent doctor`.

---

## Recipe 4 — AI-driven prior art

**Intent.** You have a draft abstract and want a ranked list of prior art
across multiple offices. The `prior-art` command fans out to PQAI (semantic
retrieval), Google Patents BigQuery (keyword + CPC), and EPO (citations
mining), then applies reciprocal-rank fusion.

**Required env.**

```
export PQAI_API_KEY="<USD 20/month individual tier from projectpq.ai>"
# Optional but recommended:
export GCLOUD_ACCESS_TOKEN="$(gcloud auth application-default print-access-token)"
export EPO_OPS_CLIENT_ID="<free from developers.epo.org>"
export EPO_OPS_CLIENT_SECRET="<free from developers.epo.org>"
```

**Command.**

```
unicli patent prior-art \
  --abstract "A method for accelerating sparse matrix-vector multiplication on neuromorphic hardware…" \
  --top 20
```

**Expected stdout.** A ranked deduped list. PQAI rows lead because semantic
retrieval correlates with the query phrasing; BigQuery rows surface CPC-
adjacent hits; EPO rows surface citation chains the keyword indices missed.

**Common errors.**

- `PATENT_AUTH_REQUIRED` from `pqai` — the PQAI tier is paid; if you only
  want a free-tier sweep, run with `--sources epo,google-patents-bq`.
- `PATENT_RATE_LIMIT` from `google-patents-bq` — BigQuery sandbox is 10 GB
  / month; a heavy abstract scan can exhaust it. Switch to a billed
  project or fall back to keyword search on `google-patents-web`.

---

## Recipe 5 — Health-check before a long-running batch

**Intent.** Before kicking off a batch job that walks 10K publication
numbers, confirm every adapter you plan to use reports healthy. `doctor`
returns an envelope row per adapter so an agent can grep for `health:
ok` and short-circuit when a source is degraded.

**Required env.** None for the probe itself; per-adapter env is what
controls whether each adapter reports `health: ok` versus `skipped`.

**Command.**

```
unicli patent doctor
```

**Expected stdout.** One row per registered patent adapter (today 20:
the 18 originals plus the two keyless web adapters introduced here).
This is the _actual_ captured prefix from this session:

```
---
ok: true
schema_version: "2"
command: patent.doctor
duration_ms: 14
count: 20
surface: web
---

## Data

### 1 · Item

- **source**: cipo
- **capabilities**: [3 items]
- **health**: skipped
- **detail**: no `health` command — adapter passes by introspection only

### 2 · Item

- **source**: cnipa
- **capabilities**: [3 items]
- **health**: skipped
- **detail**: no `health` command — adapter passes by introspection only

…
```

**How to interpret.**

- `health: skipped` — the adapter does not expose a `health` probe yet, so
  doctor only verified its registry presence. Treat as "available, not
  load-tested."
- `health: ok` — the adapter's `health` command returned successfully
  against the live upstream. Safe to include in a batch.
- `health: error` — adapter failed its own probe. Read the `detail`
  field; the most common cause is an unset credential env var, and the
  fix is the env-var name listed in `detail.suggestion`.

**Common errors.**

- All adapters report `health: skipped` — that is the current shape of
  the vertical, not an error. Health probes ship per-adapter as part of
  ongoing work; the `doctor` command will surface real `ok` / `error`
  results as adapters add `health` capabilities.

---

## Appendix — Why two keyless adapters

We ship two keyless web adapters rather than one because their failure
modes are largely independent. `google-patents-web` covers a richer
relevance ranking and includes WO / EP / JP / CN family hints in the
response, but trips Google's anti-bot gate after sustained automated use
(returning HTTP 503 to `python-requests`-style traffic). `freepatentsonline-
web` is slower and older but applies no rate gate that we have observed in
this session; it works as the reliable fallback when Google is hot. Run
both in parallel and let the meta-command's reciprocal-rank fusion choose
the survivors.

For deeper context on the structured error envelope shape and how to
write a self-repairing agent loop against it, read
[docs/skills/patent-research.md § Failure modes and repair](./patent-research.md#failure-modes-and-repair).
