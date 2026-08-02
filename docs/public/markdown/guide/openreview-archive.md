<!-- Generated from docs/guide/openreview-archive.md. Do not edit this copy directly. -->

# OpenReview Archive

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/openreview-archive
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/openreview-archive.md
- Section: Guides
- Parent: Guides (/guide/)

`unicli openreview conference` creates a resumable research archive for one
OpenReview venue. It keeps each public submission together with its review
thread, rebuttals, decisions, edit history, hosted files, and external artifact
links.

## Start with the venue group

Pass the canonical group id or its OpenReview group URL:

```bash
unicli --auth-retry openreview conference \
  "ICML.cc/2026/Conference" \
  --output ~/openreview-archives \
  --rpm 20 \
  -f json
```

```bash
unicli --auth-retry openreview conference \
  "https://openreview.net/group?id=ICLR.cc/2025/Conference" \
  --output ~/openreview-archives \
  -f json
```

The adapter reads the venue group's `submission_id`, prefers OpenReview API v2,
and falls back to API v1 for older venues. Group configuration remains the
source of truth when invitation names or decision labels differ across years.

## Authentication

Use the signed-in browser session when OpenReview requires an access token or a
browser challenge:

```bash
unicli browser profiles --json
unicli browser doctor --json
unicli --auth-retry openreview conference "ICLR.cc/2024/Conference"
```

The OpenReview client may refresh an expired access token once during the
invocation. Access and clearance credentials are restricted to OpenReview
hosts; the refresh credential is restricted to OpenReview's token endpoint.
Only records and fields whose OpenReview `readers` include `everyone` enter the
archive.

## Archive layout

```text
openreview-archives/
└── ICML.cc_2026_Conference/
    ├── manifest.json
    ├── group.json
    └── threads/
        └── <forum-id>/
            ├── record.json
            ├── edits/<edit-id>.json
            └── artifacts/<note-id>/<field>-<identity>.*
```

`record.json` retains the raw public submission and replies plus a normalized,
chronological timeline. Timeline entries carry stable note and parent ids,
invitation-derived lifecycle types, source URLs, all content sections, and a
focused `concerns` view for weakness, concern, question, limitation, and issue
fields.

OpenReview-hosted PDFs, supplementary files, appendices, source bundles, code
packages, artifacts, and rebuttal attachments are downloaded serially. Each
binary has a JSON sidecar with its source URL, size, media headers, and SHA-256.
External repository, project, and dataset URLs remain structured links so their
own host can be archived under its own authentication and rate-limit contract.

## Request pacing and recovery

The default is 20 requests per minute with one active OpenReview request per
process. The client observes `Retry-After` and rate-limit reset headers, and
retries transient API failures with bounded exponential backoff and jitter.

Run conference jobs sequentially so their aggregate rate stays predictable:

```bash
for year in 2026 2025 2024; do
  unicli --auth-retry openreview conference \
    "ICLR.cc/${year}/Conference" \
    --output ~/openreview-archives \
    --rpm 20 \
    -f json
done
```

The manifest remains `in_progress` until submissions, revisions, and the final
edit-head catch-up pass finish. Re-run the same command after interruption; the
committed cursor and artifact hashes prevent completed work from being fetched
again.

Use metadata-only mode to retain notes, revisions, and artifact references
without downloading binaries:

```bash
unicli --auth-retry openreview conference \
  "NeurIPS.cc/2025/Conference" \
  --metadata-only \
  --output ~/openreview-archives \
  -f json
```

## Inspect a tab before archiving

`openreview venue` accepts the URL shown in the browser, including a venue tab:

```bash
unicli openreview venue \
  "https://openreview.net/group?id=ICML.cc/2026/Conference#tab-accept-spotlight" \
  --limit 25 \
  -f json
```

The command resolves the tab through the venue's live decision-heading map, so
display-label capitalization does not become an API query assumption.
