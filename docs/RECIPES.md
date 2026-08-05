---
title: Recipes
description: Short, copyable Uni-CLI workflows for web data, research papers, authenticated sites, and browser sessions.
---

# Recipes

Each recipe starts with discovery and ends with data another program or agent can read.

## Read a public site

Find the command:

```bash
unicli search "top Hacker News stories"
```

Inspect its arguments, then request five items:

```bash
unicli describe hackernews top
unicli hackernews top --limit 5 -f json
```

Use `jq` to select the fields you need:

```bash
unicli hackernews top --limit 5 -f json |
  jq '.data[] | {title, url, score}'
```

## Search and read a paper

Search arXiv:

```bash
unicli arxiv search "agent computer interfaces" --limit 5 --sort submittedDate -f json
```

After selecting an ID, download the PDF and read its opening pages:

```bash
unicli arxiv download 1706.03762 --output ./papers -f json
unicli pdf read ./papers/1706.03762.pdf --first_page 1 --last_page 3 -f json
```

Run `unicli describe arxiv download` if the downloaded filename differs from the ID.

## Set up a signed-in site

Start with the operation. The error envelope will identify missing authentication.

```bash
unicli <site> <command> -f json
unicli auth setup <site>
unicli browser profiles --json
unicli auth import <site> --browser chrome
unicli auth check <site>
```

Retry the original command after `auth check` succeeds.

## Work with a browser page

Read browser health, start a provider, and inspect the page before acting:

```bash
unicli browser doctor --json
unicli browser start
unicli browser open https://example.com
unicli browser state -f json
```

Use refs from `browser state`:

```bash
unicli browser click <ref>
unicli browser type <ref> "search text"
```

Take a screenshot when the task needs visual confirmation:

```bash
unicli browser screenshot ./page.png
```

## Archive an OpenReview venue

Inspect the command and start a resumable archive:

```bash
unicli describe openreview conference
unicli openreview conference <venue-group-or-url> \
  --output ./openreview-archives \
  --rpm 20
```

Use `--metadata-only` to collect submissions, reviews, decisions, edit history, and file metadata before downloading binaries. See [Archive an OpenReview conference](/guide/openreview-archive) for the archive layout.

## Preview a write

Use `describe` to review the effect and arguments. Add `--dry-run` to preview the resolved plan:

```bash
unicli describe <site> <command> --full -f json
unicli <site> <command> [args] --dry-run -f json
```

For commands covered by the local permission policy, Uni-CLI will return the exact approval step with the planned arguments.
