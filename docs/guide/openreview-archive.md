---
title: Archive an OpenReview conference
description: Create a resumable local archive of a public OpenReview venue.
---

# Archive an OpenReview conference

`unicli openreview conference` collects public submissions, review threads, rebuttals, decisions, edit history, hosted files, and external artifact links for one venue.

## Start an archive

Pass a venue group ID or OpenReview group URL:

```bash
unicli openreview conference "ICML.cc/2026/Conference" \
  --output ./openreview-archives \
  --rpm 20 \
  -f json
```

```bash
unicli openreview conference \
  "https://openreview.net/group?id=ICLR.cc/2025/Conference" \
  --output ./openreview-archives \
  -f json
```

The venue group's configuration identifies submissions and decision headings across conference years.

## Use a signed-in session

When OpenReview asks for a login or browser challenge, inspect local profiles and browser health:

```bash
unicli browser profiles --json
unicli browser doctor --json
unicli --auth-retry openreview conference "ICLR.cc/2025/Conference"
```

The archive includes records readable by the current account and keeps public fields with each thread.

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

`record.json` contains the source notes and a normalized chronological timeline. Downloaded artifacts include sidecar metadata with source URL, media information, size, and SHA-256.

## Resume

The manifest records progress and committed cursors. Run the same command again after an interruption:

```bash
unicli openreview conference "ICML.cc/2026/Conference" \
  --output ./openreview-archives \
  --rpm 20
```

Completed artifacts are recognized from the manifest and hashes.

## Metadata first

Use metadata-only mode to collect threads, edits, decisions, and artifact references before downloading files:

```bash
unicli openreview conference "NeurIPS.cc/2025/Conference" \
  --metadata-only \
  --output ./openreview-archives
```

The `--rpm` value sets the maximum request rate for the process. Run large venue archives sequentially when they share one OpenReview account.
