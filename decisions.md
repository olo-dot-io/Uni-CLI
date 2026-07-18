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

## 2026-07-18 — Release package dependency closure

**DECISION**

Treat a clean packed installation as a distinct release boundary rather than
assuming a green repository build proves npm behavior. Every external runtime
package loaded through a literal non-test `src/` module specifier must be
declared in production dependencies and represented by a non-dev lock entry.
The release truth gate enforces this contract from TypeScript syntax instead
of maintaining another handwritten dependency list.

**SCOPE**

- Promote the existing XML DOM parser used by PubMed and bioRxiv from an
  accidental documentation-tool transitive to a direct runtime dependency.
- Parse import/export, import-equals, dynamic import, CommonJS require,
  require.resolve, and createRequire-alias syntax through TypeScript symbols,
  including late aliases, assignment, and destructured resolvers while
  excluding lexical shadows, type-only declarations, Node built-ins, relative
  modules, and package self-imports. Mutable loader-to-unrelated-value
  reassignment fails as an explicit unsupported state.
- Launch the browser broker only from a compiled installed or repository build
  artifact. A missing source-mode build is an explicit unsupported state with
  an exact recovery command, not a reason to ship the development transpiler.
- Preserve the npm 10 optional peer closure and the workflow-built Windows
  process-owner artifacts, while rejecting stale root dependency maps; do not
  regenerate the lock with npm 11 pruning.

**BEST PATH**

Keep dependency truth in `package.json`, lock install identity in
`package-lock.json`, and executable enforcement in the existing
`release-truth-check`. Validate with a deliberately missing manifest entry and
a clean production tarball install. Do not make the adapter loader silently
accept missing imports or hard-code one PubMed exception.

## 2026-07-18 — Agent-facing product category

**DECISION**

Position Uni-CLI as **the open Agent-Computer Interface runtime for real
software**. Use “Find the operation. Cross the boundary. Keep the outcome
inspectable.” as the compact product sentence. Keep `unicli` as the
implementation and distribution surface rather than making “universal CLI” the
category.

**SCOPE**

- Align the English and Chinese README, docs homepage, FAQ, architecture
  explanation, agent-readable generated assets, package metadata, and public
  copy rules around the same category.
- Preserve the existing invocation contract and package name. This is a
  positioning change, not a runtime rewrite or protocol fork.
- Describe the compact loop as discover, select, govern, act, observe, and
  repair. Map it explicitly to the existing nine executable stages: intent,
  select, govern, act, observe, diagnose, repair-or-reroute, deliver, expose.
- Separate current mechanisms from architecture direction: search/`do` rank
  operations, the caller selects one with a declared substrate, AgentEnvelope
  guarantees a stable success/error shape, and MCP projects adapter operations.
  Automatic cross-substrate arbitration, universal operation evidence, and
  fixed-core protocol parity are not shipped.

**BEST PATH**

Use the established Agent-Computer Interface term because it names the owned
boundary between an agent and a computer, while the runtime qualifier states
what Uni-CLI actually ships: ranked discovery, declared heterogeneous
substrates, supported policy, stable structured results, optional
operation-specific evidence, and repair context across web, browser, desktop,
local, file, and protocol surfaces. Treat MCP, WebMCP, CLI, browser automation,
accessibility, and visual control as complementary substrates or exposures
below that boundary.

**WHY THIS IS BEST**

Recent protocol work is specializing rather than converging on one universal
transport: MCP covers tool/data exchange, A2A covers agent collaboration, ARD
covers capability discovery, and WebMCP exposes structured page tools. Recent
provider implementations independently moved to deferred tool loading. Recent
computer-use benchmarks show that long-horizon reliability depends on hybrid
interfaces, runtime fit, action evidence, and trajectory-aware verification.
Uni-CLI's existing code owns a substantial cross-interface operation boundary;
“computer-control platform” obscures that boundary, while
“capability runtime,” “agent I/O,” and “control plane” collide with hosted
provider routers, stream normalization, and distributed infrastructure.

**EVIDENCE**

Repository command contracts, search, policy, AgentEnvelope, delivery, browser
broker, compute, retrieval, MCP/ACP exposure, generated catalog, and repair
checks; current first-party protocol/provider documentation; primary
Agent-Computer Interface, large-tool planning, hybrid-interface, and
long-horizon computer-use papers; representative upstream source, releases,
issues, and security discussions recorded in the positioning research note.

**UNSUPPORTED**

Uni-CLI is not an agent model or planning framework, a distributed agent
hosting platform, an enterprise MCP gateway, a hosted OAuth integration
marketplace, an operating system, or a claim that all software paths are
equally reliable. Discovery does not prove executability; `do` is plan-only;
the runtime does not automatically select the strongest substrate; dispatch
does not prove task completion; evidence is operation-specific; fixed core
commands can be listed by MCP discovery without being callable by `unicli_run`;
and visual fallback is not a universal default.

**VETO**

Revert the positioning commit; the runtime and package contracts remain
unchanged.

## 2026-07-18 — Local evidence and exact compute state

**DECISION**

Keep diagnostics as bounded owner-only JSONL, while separating the generic
recoverable file-store lock and exact source/build identity from event
schema/storage. Use that same lock abstraction at the compute-ref persistence
boundary so shard pruning and reads share one linearization point. Keep compute
refs as immutable target-sharded records and publish empty latest buckets as
tombstones. Use only Node/Rust/platform primitives already owned by the runtime;
add no database, daemon, telemetry SDK, timing retry, or source-specific
persistence path.

**BEST PATH**

Hard-link lock election, durable complete owner records, no-follow bounded
reads, inode-checked dead-owner reclamation, two agreeing dirty-content passes,
serialized ref record publication/pruning, exact capture identity binding, and
target tombstones make false evidence unrepresentable at the owning local
boundaries. Broken or concurrently changing state fails explicitly rather than
being guessed, stolen, retried blindly, or revived.

**UNSUPPORTED**

An in-process logger cannot survive a terminal event that never executes or
promise remote durability. Non-cooperating filesystem mutation and externally
held Windows handles remain explicit I/O failures. Live Windows and Linux
desktop validation is provided by their CI/native gates; this macOS release run
cannot itself observe those hosts.
