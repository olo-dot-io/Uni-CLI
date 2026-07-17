# Engineering Decisions

## 2026-07-17 — Broad AI primary-source intelligence boundary

**DECISION**

AI intelligence coverage is defined by three registry-backed layers rather
than a growing list of vendor-specific scrapers:

1. a maintained primary-source directory for laboratories, hardware vendors,
   model hubs, runtimes, research venues, benchmarks, and embodied/world-model
   projects;
2. role profiles that turn practitioner concerns into explicit source and
   query scopes;
3. live search and pulse commands that execute compatible native adapters and
   retain provider timestamps, provenance, partial failures, and auth state.

Only missing stable public boundaries receive new adapters. This extension
adds direct ModelScope, OpenCSG, and Bluesky-post APIs and federates existing
OpenReview, OpenAlex, Crossref, ACL Anthology, social, video, and regional
community commands. Authenticated sources remain selectable and visible but do
not become silent default dependencies.

**SCOPE**

- `ai search` gains profile-aware official-source selection and a much larger
  registry source set.
- `ai pulse` returns an on-demand latest snapshot for a practitioner role.
- `ai landscape` exposes the maintained first-party target matrix without
  network I/O.
- "First-time" means every invocation reads current upstream state. It does
  not claim a background daemon, zero indexing delay, or freshness where the
  upstream source supplies no timestamp.

**BEST PATH**

Keep orchestration in the existing `ai.*` adapter boundary shared by CLI and
MCP. Make source expansion data-driven, select official domains by query and
role, reuse native adapters before adding code, and reject unsupported or
undated states explicitly. This is smaller and more robust than copying one
scraper per laboratory, product, or documentation site.

## 2026-07-17 — Agent dogfood hardening boundary

**DECISION**

Treat the three independent NVLink, domestic-accelerator, and deep-algorithm
consumer rehearsals as disproving experiments against the unified `ai search`
and `ai read` contract. Fix failures at those two owning boundaries rather
than teaching agents a growing collection of raw fallback commands.

The immediate contract is:

1. binary/PDF and anti-bot challenge responses fail closed or route through a
   declared artifact reader; they never become successful Markdown;
2. exact vendor/entity queries select only matched maintainer domains before a
   profile fallback is considered;
3. hosted papers, models, and datasets retain their platform provenance but
   are not mislabeled as platform-maintained official content;
4. paper results route to the scholarly full-text boundary, and GitHub issue
   or PR URLs route to structured thread readers;
5. deep AI-hardware and algorithm vocabulary discovers the unified `ai`
   commands without requiring the caller to know the product category name.

**SCOPE**

This change closes machine-readable retrieval defects demonstrated by the
dogfood runs. Diagram OCR, equation/table anchors, commit-pinned code line
retrieval, and a complete paper/repository/review/benchmark evidence graph
remain explicit unsupported states; they are not simulated with generic HTML
or inferred metadata.

**BEST PATH**

Reuse the existing PDF, scholarly, GitHub CLI, registry, and error-envelope
boundaries. Add only missing structured GitHub thread commands, two missing
domestic vendor identities, and semantic discovery vocabulary. Do not add one
scraper per product or silently send protected pages through third-party
readers.
