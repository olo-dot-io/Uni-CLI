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
