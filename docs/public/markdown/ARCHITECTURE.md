<!-- Generated from docs/ARCHITECTURE.md. Do not edit this copy directly. -->

# Architecture

- Canonical: https://olo-dot-io.github.io/Uni-CLI/ARCHITECTURE
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/ARCHITECTURE.md
- Section: Project

Uni-CLI is a local command runtime for operating real software. This page describes the runtime in v1.5.0. Its main abstraction is an operation with a name, arguments, target, effect, execution operator, and result contract.

## Runtime flow

```text
intent
  → compiled intent plan
  → feasible catalog candidates
  → ranked operations with evidence
  → operation contract
  → argument and permission checks
  → execution operator
  → AgentEnvelope
  → repair or next action
```

The same operation can be discovered from the CLI, MCP, ACP, generated agent assets, and the documentation catalog. `architecture tree` and `architecture audit` inspect the nine executable control stages (`intent`, `select`, `govern`, `act`, `observe`, `diagnose`, `repair-or-reroute`, `deliver`, and `expose`). `unicli search` and `unicli do` rank catalog operations. `unicli do` remains plan-only so the caller selects and runs the next command explicitly.

## Catalog

The catalog combines four sources.

1. packaged YAML and TypeScript adapters
2. fixed core commands
3. user adapters under `~/.unicli/adapters/`
4. plugins and host-discovered external CLIs

`unicli search` compiles the task and ranks the catalog. `unicli describe` returns the selected operation's contract. User adapters can replace packaged entries with the same site and command during local development.

## Intent compilation and ranking

Discovery compiles each request once before it reads posting lists. The plan keeps the remaining task text together with entity, cardinality, site, operation family, operator, browser-negation, and other hard requirements.

Exact site ids and maintained aliases resolve through hash indexes. Multi-word names resolve through bounded phrase matching. A precomputed symmetric-delete index proposes typo candidates, then bounded Damerau-Levenshtein distance accepts only one nearest provider. Catalog vocabulary remains ordinary query text, so a term such as `computer` keeps its meaning during typo resolution. Ambiguous spellings add no site constraint.

The bilingual inverted index combines BM25 and TF-IDF. Entity, workflow, operation-family, and feasibility signals refine the lexical candidate set. Hard capability requirements remove incompatible commands before bounded top-k selection. Every result includes `ranking.lexical_score`, `ranking.semantic_score`, `ranking.prior`, and named `ranking.signals` so an agent can inspect the selection basis.

Host-discovered macOS commands reuse the index derived from the current inventory snapshot. Inventory refresh, configuration changes, and explicit invalidation update the registry, affected compiled command keys, and derived index together. User-authored commands retain priority over host inventory in both runtime and manifest discovery. Resident CLI consumers and MCP share the inventory owner. Hardware and algorithm vocabulary resolves the unified `ai` commands directly during discovery.

## Evidence retrieval

`retrieval search` selects registered read-only sources and dispatches them through the control kernel with bounded concurrency. Source metadata owns argument projection and result classification. Each result retains its source record, canonical URL, timestamps, and next-read command. Source failures include an exact retry command.

Reciprocal rank fusion counts the best rank for each distinct source and canonical result. Repeated rows from one source contribute once. The requested relevance or timestamp ordering is applied before bounded top-k selection. Equal ordering keys retain their first-seen order. Partial failures remain attached to usable results. An all-source failure retains provider causes and retry routes; successful sources with no matches produce `empty_result`.

The evidence reader follows redirects and records the original and final URLs. HTML cleanup selects one semantic content root for both Markdown and plain text. Turndown owns Markdown rendering, and `html-to-text` owns plain-text rendering so literal punctuation and code survive conversion. The evidence envelope owns output truncation and link resolution. Binary responses, PDFs, and anti-bot challenge responses fail closed or route through a declared artifact reader such as `scholar-artifacts.read-pdf`. GitHub issue and pull-request URLs route to the structured `gh.issue-thread` and `gh.pr-thread` readers.

AI primary-source intelligence combines three registry-backed layers in `src/commands/ai.ts`, `src/commands/ai-landscape.ts`, and `src/commands/ai-content.ts`. The first layer is a maintained primary-source directory for laboratories, hardware vendors, model hubs, runtimes, research venues, benchmarks, and embodied or world-model projects, exposed without network I/O by `ai landscape`. The second layer defines practitioner role profiles (`ai profiles`) that map daily concerns to source refs and query scopes. The third layer runs `ai search`, `ai pulse`, and `ai read` across compatible native adapters, including direct `modelscope`, `opencsg`, and `bluesky` APIs alongside `openreview`, `openalex`, `crossref`, `acl-anthology`, social, video, and community commands. Every invocation reads current upstream state and retains provider timestamps, provenance, partial failures, and authentication state. Authenticated sources remain opt-in (`--include-auth`). Exact vendor or entity queries select matched maintainer domains before profile fallback. Hosted papers, models, and datasets retain platform provenance under `hosted-artifact` and `hosting_platform`. Paper results set `next_read` to `unicli scholar read`.

### Scholarly routing

- `scholar search` runs each source through its queryable search command (`findScholarQueryableSearchCommand` in `src/commands/scholar.ts`), so the arXiv source uses `arxiv search` and its rows match the query.
- `--year` takes one year or an inclusive range such as `2024-2026` (`src/adapters/_shared/year-range.ts`). The arXiv, Crossref, OpenAlex, PubMed and Semantic Scholar searches apply the range in their own APIs. DBLP applies a single year.
- An empty answer is a definite miss (`*_NOT_FOUND`, exit 66) only when every source answered. When a source failed and no rows came back, the envelope code is `SCHOLAR_SOURCES_UNAVAILABLE` with each source's state in `details.sources`, exit 75 when the failure is retryable and 69 otherwise (`exitScholarEmpty`).
- arXiv matches word stems, so `arxiv search` keeps every row the API returned and ranks exact term and phrase matches first. `--sort` accepts `relevance`, `newest` (submission date) and `updated`.
- OpenReview (`api2.openreview.net`) answers anonymous `POST /notes/search` requests. `GET /notes`, forum pages and PDFs answer only sessions holding a clearance cookie or a login. `openreview paper`, `venue` and `reviews` read notes through the search API first (by `ids`, by `venueid` or `invitation`, and by the reply group `<domain>/Submission<N>`) and use `GET /notes` as the second route (`readNotes` in `src/adapters/openreview/papers.ts`). Venue listings include rejected and withdrawn submissions with the decision in `venue`.

## Operation contract

An operation contract records the following fields.

- site, command, description, and argument schema
- target surface and compatible platforms
- execution operator and minimum capability
- operation family, effect, and idempotency
- authentication and interaction requirements
- adapter source and repair metadata

These fields are shared by discovery, dry-run, execution, permission checks, and protocol projections.

## Control kernel

The control kernel validates input and coordinates policy before an operator acquires its target. It handles the following work.

- argument schemas and input channels
- permission profiles and approvals
- browser session and target ownership
- run recording and effect metadata
- error mapping and process status

The kernel returns one execution plan to the selected operator.

## Execution operators

| Operator                | Typical boundary                           |
| ----------------------- | ------------------------------------------ |
| `structured-api`        | HTTP API or structured page endpoint       |
| `browser-protocol`      | CDP or browser network protocol            |
| `native-cli`            | Installed external command                 |
| `browser-semantic`      | DOM and accessibility actions in a browser |
| `desktop-accessibility` | OS accessibility tree and native controls  |
| `visual-observation`    | Screenshot or pixel observation            |
| `visual-coordinate`     | Coordinate-based desktop action            |
| `local-runtime`         | Files, local functions, and core services  |

Adapter type, strategy, and operator describe different parts of the call. A browser adapter can expose a protocol operation; a web namespace can wrap a native CLI.

## Adapter engine

YAML adapters describe a pipeline of registered actions such as fetch, transform, browser interaction, file download, and control flow. Transport-native actions add platform capabilities for visual and accessibility providers.

TypeScript adapters use the same metadata and envelope contract for SDKs, streaming services, and custom state machines.

## Browser runtime

The Browser Runtime Broker owns providers, profile partitions, agent sessions, targets, and leases. Browser commands select one of these visibility modes.

- hidden managed browser
- background existing Chrome
- foreground existing Chrome
- configured remote provider

State reads produce refs tied to a snapshot and target. Later actions resolve those refs through the same session. Auto-start launches the broker from the compiled `runtime-broker-main.js` artifact in the installed distribution or repository build output (`src/browser/runtime-launch.ts`). Missing source-mode builds return a structured error with the `npm run build` recovery command.

- A managed browser runs inside the long-lived broker process, so the broker never reads the caller's environment. `createBrowserInvocationScope` puts the caller's `UNICLI_BROWSER_PROFILE_ID` into a managed, non-ephemeral scope when no explicit profile id is given, and the scope carries it to the broker with every request (`src/browser/invocation-scope.ts`). The same variable already selects the profile for cookie-backed YAML adapters, so one setting serves both adapter kinds.
- `broker.status` reports `package_version` (`src/browser/runtime-broker.ts` and `src/browser/runtime-protocol.ts`). `ensureBroker` reuses a running broker of the same version, or of any version with live sessions (`src/browser/runtime-launch.ts`). It retires an idle broker of another version and starts its own, because a broker left by an older install imports modules that the upgrade removed. A broker that reports `shutting_down` is waited for (`waitForBrokerExit`) until it stops answering, and then a new broker starts.

### Social post rows

- `twitter search`, `tweets`, `user-tweets`, `user-timeline`, `list-tweets`, `thread`, `likes` and `bookmarks` share the columns in `TWEET_COLUMNS` (`id`, `author`, `text`, `created_at` in ISO 8601, `likes`, `retweets`, `views`, `url`). The counts are integers. The browser path (`buildTwitterTweetExtractionScript` in `src/adapters/twitter/browser-extraction.ts`) reads them from accessibility labels, which carry exact integers in every interface language; visible text such as `4.5万` or `45K` is rounded and localized. The GraphQL path (`extractTweet` in `src/adapters/twitter/client.ts`) converts `legacy.created_at` and the view count.
- X removes posts that leave the viewport. `collectTweets` therefore extracts after every scroll, keeps posts by id, and stops when the requested number is reached or three scrolls in a row add nothing. `twitter search` and the timeline commands accept up to 100 posts.
- `zhihu articles` lists newest first by default (`--sort created`; `--sort voteups` gives the most upvoted first) and each row carries `id`, `created_at`, `updated_at`, `url`, vote and comment counts (`src/adapters/zhihu/articles.yaml`). It takes a `url_token`; `zhihu user` (`src/adapters/zhihu/user.yaml`) returns that `url_token` and also accepts the hashed id that `zhihu search` returns.

## Desktop and visual runtime

`compute` routes actions to available providers on macOS, Windows, Linux, Electron, or an attached visual driver. Snapshot responses describe the selected provider and return refs for follow-up actions. Health commands report the setup supported by the current host.

Cua Driver owns native coordinate conversion and capture mapping. Uni-CLI forwards screenshot-pixel coordinates, capture identity, and the provider session recorded with the observation. Combined native capture binds the exact window identity across snapshot and screenshot (`src/compute/capture.ts`). Compute element refs persist in target-sharded atomic records under a recoverable file-store lock (`src/transport/refs.ts` and `src/runtime/recoverable-file-lock.ts`). Empty latest buckets publish tombstones so older refs remain retired. Driver idle cleanup owns the provider session lifetime. `unicli doctor compute --providers --install` uses the official installer for a missing driver and probes the installed contract again. The [compute guide](/guide/browser-desktop#native-coordinate-driver) describes platform setup and observation lifetimes.

## Result envelope

Every normal command returns a v2 AgentEnvelope. The outer fields remain stable across interfaces.

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "site.command",
  "meta": {},
  "data": {},
  "error": null
}
```

Failed calls place their stable code, message, suggestion, and available repair data under `error`. The process exit code mirrors the broad failure class.

## Repair

Adapter failures can expose `adapter_path` and `step`. The agent updates that owned source and runs `unicli repair`, which invokes the original target as the verifier. User adapters provide a local path for repairs under evaluation.

## Harness evolution kernel

The evolution kernel turns selected run traces into a controlled adapter update. It owns five boundaries.

1. `runs distill` creates a private evidence packet without replay arguments or secret event fields. Its provenance marks local trace content as untrusted and keeps raw traces behind local references.
2. `evolve adapter` copies the baseline and candidate into separate user-adapter overlays. A changed candidate must declare a hypothesis, expected fixes, and optional at-risk cases. The scope keeps identity, input and output contracts, pipeline actions, request methods and headers, and existing subprocess invocations fixed. New network origins require `--allow-origin` at session creation.
3. Proposal runs, validation runs, and held-out runs remain disjoint. Eval files may label cases with `train`, `validation`, or `held-out`.
4. Baseline and candidate cases execute through the public CLI in alternating order. Every attempt preserves its exact candidate, patch, and report with content hashes. Rejected attempts remain available after a later candidate succeeds.
5. `evolve adapter --candidate ... --promote` installs the candidate only after strict validation improvement and a held-out result without regressions. Promotion prepares the exact rollback artifact before installation. Promotion and rollback resume after an interrupted write.

The upstream Agent proposes and edits the candidate. Uni-CLI owns execution evidence and the promotion decision. Promotion reuses the latest eligible attempt when its candidate hash is unchanged, so review does not trigger another evaluation. Attempt commits, promotion, and rollback are serialized across Agent processes. Session format v2 verifies immutable artifacts and migrates the attempt history written by the development v1 format. Invalid sessions remain visible in `evolve inspect`. Version 1.2 limits editable evolution components to one YAML adapter per session. Mutating commands require an explicit evaluation opt-in.

## Protocol projections

The native CLI exposes the complete runtime. MCP offers compact, deferred, and expanded tool profiles. Fixed core commands can appear in MCP discovery and return `unsupported_surface` with their native CLI invocation when called through `unicli_run` (`src/mcp/handler.ts`). ACP and other generated surfaces project selected operations from the same catalog. `unicli mcp health` reports the exact MCP profile and tool counts on the installed version.

## Design decisions

Local diagnostics and release packaging enforce two additional runtime contracts.

- Local diagnostic logs write bounded owner-only JSONL under `~/.unicli/logs/events/` and serialize reads, pruning, and appends with the shared recoverable file-store lock (`src/runtime/local-event-log.ts` and `src/runtime/recoverable-file-lock.ts`). Lock election uses hard-linked owner records, inode-checked dead-owner reclamation, and no-follow bounded reads. Process source identity (`src/runtime/source-identity.ts`) records the packaged `build-identity.json` artifact or verifies two agreeing worktree content passes before labeling a dirty digest. A failure before the first pipeline step carries step `-1` in its error envelope, and the local event log records `error_step` only for steps from 0, so such a failure writes no validation warning (`src/engine/kernel/execute.ts` and `src/runtime/cli-invocation-log.ts`).
- Packed releases enforce production dependency closure in `scripts/release-truth-check.ts`. Every external package loaded through a literal non-test `src/` module specifier, including `import`, `export`, `import = require()`, dynamic `import()`, `createRequire`, and `require.resolve` aliases (such as `@xmldom/xmldom` in `pubmed` and `rxiv`), is declared in `package.json` `dependencies` or `optionalDependencies` with a non-dev `package-lock.json` entry. The checker uses TypeScript symbol binding to exclude lexical shadows, type-only imports, Node built-ins, relative modules, and package self-imports. It also rejects mutable loader reassignments, root manifest-to-lock mismatches, and unbundled Windows process-owner sidecars.

## Source map

| Area                       | Source                             |
| -------------------------- | ---------------------------------- |
| Catalog and registry       | `src/registry.ts`, `src/adapters/` |
| Intent compilation         | `src/discovery/intent-plan.ts`     |
| Catalog ranking            | `src/discovery/search.ts`          |
| Ranking semantics          | `src/discovery/intent-ranking.ts`  |
| Site identity resolution   | `src/discovery/site-resolver.ts`   |
| Capability feasibility     | `src/discovery/feasibility.ts`     |
| Engine and pipeline        | `src/engine/`                      |
| Harness evolution          | `src/engine/evolution/`            |
| Command surface            | `src/commands/`                    |
| Browser runtime            | `src/browser/`                     |
| Desktop and visual control | `src/compute/`, `src/transport/`   |
| Shared contracts           | `src/types.ts`, `src/core/`        |
| Protocol servers           | `src/mcp/`, `src/commands/acp.ts`  |

## Related reference

- [How Uni-CLI works](/how-it-works)
- [Adapter format](/ADAPTER-FORMAT)
- [Pipeline steps](/reference/pipeline)
- [Exit codes](/reference/exit-codes)
