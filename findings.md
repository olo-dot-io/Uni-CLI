# Production Truth Release Findings

Date: 2026-07-12

This record makes the release's external reference loop auditable. Local source,
executable checks, and runtime output remained the deciding evidence; upstream
work supplied failure vocabulary and prevention patterns, not copied behavior.

## Reproduced baseline

- Base commit: `36db83185eb524b3425653ba5de724b9864a01db`.
- Node 22/24 global fetch rejected an npm Undici 8 dispatcher with
  `UND_ERR_INVALID_ARG: invalid onRequestStart method`.
- A proxy-configured Hacker News request collapsed to `internal_error` instead
  of preserving the network cause.
- Repair could report `ok:true` and `improved:false` after its npm, git, and
  backend operations failed, while the process exited nonzero.
- Implicit cookie persistence produced a `0755` directory and `0644` JSON file
  under a normal `0022` umask.
- The updater queried the unscoped `unicli` registry URL and retained metadata
  commands while its request was pending.
- The capability matrix published 103 names, while executable ownership
  resolved to 105 names and the two sets disagreed.

## Refreshed source heads

| Repository                                                              | Inspected commit                           | Role in this work                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [OpenCLI](https://github.com/jackwener/OpenCLI)                         | `c1ad69676f220b5ef382bbf4c387a2486daf8355` | Primary same-module comparison for proxy, repair, cookie permissions, CI, and command oracles. |
| [browser-use](https://github.com/browser-use/browser-use)               | `68afe46456a23009a7d5eec2017ec7ab51b7c027` | Refreshed browser-agent reference; not used to override local browser evidence.                |
| [CUA](https://github.com/trycua/cua)                                    | `8c921b2b3bf13494724ead4f0a814d80c56a7e8b` | Refreshed computer-use reference; no release claim depends on it.                              |
| [Open Interpreter](https://github.com/OpenInterpreter/open-interpreter) | `764a96ee05853d5494d7e711eefecec57ab712ef` | Refreshed local-computer reference; no release claim depends on it.                            |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp)           | `5f8fc00210b27b4407c375b59cda4838045d429c` | Refreshed MCP/browser reference; no release claim depends on it.                               |
| [brapper](https://github.com/ruvnet/brapper)                            | `d1d968f257ff00254050f163c05ba5215c2591fe` | Refreshed browser wrapper reference; no release claim depends on it.                           |

The nested checkout layout is local and ignored. `scripts/sync-ref.sh` now
discovers nested repositories, records before/after SHAs, rejects dirty or
diverged checkouts, and fails when it synchronizes zero repositories.

## Search vocabulary and upstream threads

| Search terms                                                                  | Primary thread/source                                                                                                                                                                                                                                                        | Local prevention derived from it                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EnvHttpProxyAgent invalid onRequestStart dispatcher`                         | [OpenCLI PR #512](https://github.com/jackwener/OpenCLI/pull/512), [Undici #4780](https://github.com/nodejs/undici/issues/4780), [#3856](https://github.com/nodejs/undici/issues/3856)                                                                                        | `src/engine/proxy.ts` makes npm Undici own both fetch and dispatcher; direct pipeline/OAuth/download/HTTP transport paths call that boundary; `tests/unit/proxy.test.ts` exercises a real local proxy. |
| `repair adapter max attempts original command oracle trace adapterSourcePath` | [OpenCLI PR #866](https://github.com/jackwener/OpenCLI/pull/866), rejected [PR #863](https://github.com/jackwener/OpenCLI/pull/863), simplifying [PR #1257](https://github.com/jackwener/OpenCLI/pull/1257)                                                                  | Hidden git/npm/backend mutation was deleted. `src/engine/repair/plan.ts` and `verifier.ts` use one bounded, shell-free original-command oracle; integration tests require envelope/exit agreement.     |
| `cookie file 0644 chmod 0600`                                                 | [OpenCLI issue #1741](https://github.com/jackwener/OpenCLI/issues/1741), [PR #1742](https://github.com/jackwener/OpenCLI/pull/1742)                                                                                                                                          | Live acquisition is memory-only. Explicit persistence in `cookie-storage.ts` uses POSIX directory `0700`, file `0600`, atomic replacement, legacy tightening, and symlink rejection.                   |
| `detached update notifier unref foreground exit`                              | [update-notifier source at `fbe4d67`](https://github.com/sindresorhus/update-notifier/blob/fbe4d6748b76da4e0b955ed39b7911e8804e58eb/update-notifier.js), [Undici #4405](https://github.com/nodejs/undici/issues/4405)                                                        | The foreground reads cache only; a detached worker performs the bounded scoped-registry request. Root help/version use constant-time paths.                                                            |
| `npm audit production dependencies workflow`                                  | [OpenCLI security workflow at `c1ad696`](https://github.com/jackwener/OpenCLI/blob/c1ad69676f220b5ef382bbf4c387a2486daf8355/.github/workflows/security.yml), [Undici advisory GHSA-vmh5-mc38-953g](https://github.com/nodejs/undici/security/advisories/GHSA-vmh5-mc38-953g) | Undici 8.7.0 and js-yaml 4.3.0 remove the reported production advisories; Node 22/24 CI and the canonical release verify gate repeat audit/truth checks.                                               |
| `Jina Reader X-No-Cache stale cached snapshot`                                | [Jina Reader API](https://r.jina.ai/docs), [Jina Reader guide](https://jina.ai/reader/)                                                                                                                                                                                      | The Jina adapter sends `X-No-Cache: true`; a live check against `example.com` returned the current `Example Domain` content instead of a stale unrelated snapshot.                                     |

## Observed acceptance evidence

- Node 22.23.1 and Node 24.18.0 each passed 250 unit-test files: 2,807
  passed and 2 skipped on the same production source.
- `npm run verify:clean` passed unit, adapter, performance, coverage,
  integration, conformance, export, stats, truth, changeset, and boundary
  gates. The integration project passed 11 files (21 passed, 7
  credential-gated skips); adapter verification passed 170 files and 6,467
  tests.
- `npm run e2e:real` passed all 44 real workflows with zero failures/skips.
- The direct engine proxy regression reaches an invalid upstream hostname only
  through the test-owned local proxy, proving the public engine path cannot
  silently bypass proxy configuration.
- `npm audit --omit=dev --audit-level=moderate` reports zero vulnerabilities.
- Fixture shape, live endpoint, and authenticated-browser evidence remain
  separate claims; inventory count is not operational-health evidence.
- The packed `@zenalexa/unicli@0.227.0` artifact is 2,869,550 bytes compressed
  and 14,257,485 bytes unpacked (3,890 entries; SHA-1
  `233c544433eedc6e40a9a14df429ccf5852855fc`). A clean local install returned
  live Hacker News data, preserved `network_error` with exit 75 through a dead
  proxy, made repair success/failure match its oracle and process exit, wrote
  explicit cookies as `0700/0600`, exposed `PRIVACY.md` and `SECURITY.md`, and
  completed MCP initialize plus the four-tool default listing.

## Independent release audit closure

An independent read-only audit found no P0 issue and four release-blocking P1
gaps. The release candidate closes each at its owning boundary:

- direct engine/OAuth/download/transport fetch paths now use the canonical
  proxy owner, with an actual local proxy regression;
- only adapter-drift error classes recommend `repair`, and every public skill
  describes it as verification rather than automated mutation;
- repair truth integration is part of `npm run verify` on Node 22 and 24;
- the tag workflow executes the canonical `npm run verify` gate rather than a
  hand-maintained subset.

The same closure also makes empty cookie export an `auth_required` envelope
with exit 77, includes `PRIVACY.md` and `SECURITY.md` in the npm artifact, and
records the reference trail in this tracked file.

## Release-gate portability finding

The first `v0.227.0` tag run (`29195080361`) correctly stopped before npm
publish. Its Linux/Node 24 environment exposed seven host-contaminated unit
failures: `CI` suppressed three explicitly forced update-check tests, while
four macOS seed simulations inspected the host Linux platform. The same run
also showed that two `it.runIf` cases made generated test inventory 9,272 on
Linux versus 9,274 on macOS.

The owning fixes make explicit force override only implicit CI/non-TTY update
suppression, declare `darwin` inside macOS seed simulations, restore the host
platform after each test, and always register the two case-sensitivity tests.
No `0.227.0` npm package or GitHub Release was created; the patch release must
pass the actual Linux release gate before publication.

The follow-up push CI run (`29195610866`) passed Linux Node 22/24, macOS, and
all three Rust sidecar jobs, then stopped on three Windows assertions. Two
revealed that the serialized profile-seed manifest inherited the host path
separator even while simulating its supported macOS format; manifest-relative
paths now use POSIX separators at the production boundary. The third revealed
that the nested Git fixture inherited the runner's global `core.autocrlf`;
the fixture now owns that Git setting so its fast-forward oracle measures
repository synchronization rather than runner configuration.

## v0.227.1 publication candidate

- GitHub Actions run [`29196085654`](https://github.com/olo-dot-io/Uni-CLI/actions/runs/29196085654)
  passed Linux Node 22/24, Windows Node 22, macOS, and the Linux, Windows, and
  macOS Rust sidecar jobs from commit `8620b2d2`.
- The versioned `npm run verify:clean` gate passed 250 unit files (2,807 passed,
  2 skipped), 11 integration files (21 passed, 7 credential-gated skips), 170
  adapter files (6,467 passed), performance, coverage, stats, truth,
  conformance, export, changeset, and public-boundary checks.
- `zenalexa-unicli-0.227.1.tgz` is 2,869,676 bytes compressed and 14,257,888
  bytes unpacked (3,890 entries; SHA-1
  `ec1c7e5562c58076af171d92b09aa279a918bcd8`). A clean install returned live
  Hacker News data; a dead proxy preserved `network_error` and exit 75 without
  suggesting adapter repair; repair success and failure matched their exact
  oracle envelopes and process exits; explicit cookie storage was `0700/0600`;
  and MCP initialized as `0.227.1` with exactly four default meta-tools.
- Eleven installed `--version` invocations measured 28.49 ms on the first run,
  28.33 ms warm p50, and 35.36 ms warm maximum in this acceptance environment.
  This is an installed-artifact probe, not a replacement for the separately
  labeled benchmark matrix.

## v0.400.0 Windows Native Messaging closure

- **Chromium source:** commit
  `1cb6db540b81d9c2ba3a5e3c1cc383f3871856e8`,
  [`launch_context.cc`](https://chromium.googlesource.com/chromium/src/+/1cb6db540b81d9c2ba3a5e3c1cc383f3871856e8/chrome/browser/extensions/api/messaging/launch_context.cc)
  and
  [`launch_context_win.cc`](https://chromium.googlesource.com/chromium/src/+/1cb6db540b81d9c2ba3a5e3c1cc383f3871856e8/chrome/browser/extensions/api/messaging/launch_context_win.cc),
  search terms `AppendArg origin parent-window`,
  `LaunchNativeHostViaCmd`, `start_hidden`, and `named pipe`. Chromium passes
  origin first and `--parent-window` second. Its default Windows path wraps the
  absolute host command with `%COMSPEC% /d /s /c`, redirects two byte-mode
  named pipes, sets the executable directory as cwd, and hides startup.
- **Platform source:** Microsoft
  [moving/replacing files](https://learn.microsoft.com/en-us/windows/win32/fileio/moving-and-replacing-files)
  and
  [`MoveFileEx`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa),
  search terms `replace existing executable`, `sharing violation`, and `open
handle`. An executing image cannot be the in-place update boundary.
- **Review threads:** PR #109
  [Windows launcher review](https://github.com/olo-dot-io/Uni-CLI/pull/109#discussion_r3600827828)
  and
  [`target_unusable` review](https://github.com/olo-dot-io/Uni-CLI/pull/109#discussion_r3600827830).
  They became a real architecture-matched PE launcher, one strict shared error
  validator, and fail-closed target invalidation without reconnecting the host.
- **Local prevention:** Windows publishes the launcher and strict Node config
  as one immutable content-addressed generation-directory rename. Competing
  installers validate the winner; reinstall and upgrade never replace a
  running image. Windows CI exercises direct launch, Chromium's default
  `cmd.exe` plus two named-pipe route in both directions, two-process first
  install convergence, active-host reinstall, and side-by-side upgrade.

## 2026-07-17 AI/AI-infrastructure retrieval closure

### Local root causes

- The three keyless public-search adapters used a nonexistent `url_encode`
  template filter and then supplied the obsolete scalar `extract.selector`
  schema. Fixing only the filter exposed the deeper boundary defect: the
  engine's `extract` action always acquired a browser even when its input was
  fetched HTML. The owning fix gives the existing action transport-parity for
  HTTP HTML and CDP DOM extraction, with one typed field contract.
- `hf.models` delegated to a removed `huggingface-cli search` command. The
  Hugging Face Hub public APIs already expose models, datasets, and Spaces
  with sortable `createdAt`/`lastModified` metadata, so those APIs now own the
  adapter boundary. The public Discourse JSON search owns forum retrieval.
- GitHub's adapter exposed repository search but not global issue/PR search or
  repository-scoped discussion search, despite current `gh` supporting all
  three with structured JSON.
- Turndown received complete application HTML, including script/style/template
  branches. A shared converter now removes non-content DOM branches before
  both `web.read` pipelines and the one-shot `extract` command render Markdown.
- AI retrieval was individually callable but not discoverable or composable.
  `unicli ai` now discovers commands from `ai.*` capability tags, fans out
  through the shared kernel, canonicalizes and fuses records, preserves
  provenance/retrieval time, and turns every partial source failure into an
  exact retry action.
- The first orchestration draft was Commander-only, so MCP advertised AI
  commands that its shared invocation kernel could not execute. The final
  boundary is an ordinary TypeScript adapter: CLI, default/expanded/deferred
  MCP, discovery, contracts, and source execution now resolve the same three
  commands.
- Authentication metadata originally inferred only browser/cookie strategy.
  GitHub search is public data behind the user-owned `gh` credential boundary,
  so executable capability metadata now drives discovery, exit 77, setup, and
  next actions (`gh auth login` / `gh auth status`) without invented cookies or
  `ai.com` guidance.
- Sequential, unbounded fan-out let one raw fetch stall an entire Agent task.
  Source calls now run in a six-worker pool with per-source abort deadlines;
  HTTP text/JSON and child-process pipeline boundaries propagate cancellation
  instead of leaving background work alive.
- URL-only fusion cannot identify the same paper across Hugging Face, arXiv,
  and Semantic Scholar. Canonical records now retain DOI, normalized arXiv,
  and Semantic Scholar identifiers and merge overlapping identifier aliases;
  author arrays/objects/strings, year, citation/reference metrics, and Atom
  repeated `author.name` fields normalize without XML leakage.
- Lobsters' `/search.json` currently returns HTTP 400 because the Rails search
  controller rejects the injected format parameter. The adapter now owns the
  supported HTML `/search` boundary and extracts semantic story records from
  the live DOM rather than accepting a permanent default-source error.
- A current network call proves retrieval time, not source publication time.
  `ai search` now exposes an explicit `--sort latest` mode, a strict
  `--since YYYY-MM-DD` filter, normalized source timestamps, and a
  `freshness_verifiable` flag. Timestamp-capable sources request their newest
  ordering and the fusion layer reorders a bounded relevance window; undated
  records remain honest in latest mode and are excluded when `--since` makes a
  verifiable time bound mandatory. `ai read` remains the content-refresh step
  for canonical documentation URLs whose search-index titles can lag.
- Search-index documentation dates are now accepted only from an anchored,
  explicit date prefix and marked `timestamp_origin: search-index-snippet`;
  native provider timestamps remain `source-field`. A strict `--since` window
  that sees only undated candidates exits 66 with the exact no-`--since` retry
  instead of either fabricating a date or reporting generic adapter failure.
- DuckDuckGo can return HTTP 202 challenge markup with no results. The shared
  `extract` step now distinguishes configured challenge, legitimate-empty, and
  required-selector-miss states. The live challenge exits 77 and routes to
  Yahoo/Brave rather than returning a false successful empty array or proposing
  a cookie flow the public HTTP adapter cannot consume.
- Algolia typo tolerance made latest Hacker News searches for `ROCm` rank
  `Roman` and unrelated rocky-planet stories. The adapter now disables typo
  tolerance for both relevance and date endpoints; the live latest probe
  returned MI355X, AMD GPU, and exact ROCm evidence.
- Repeating every partial failure on every fused row caused output growth of
  O(results \* failures). Every row now carries the failure count while only
  the first row carries the structured source-error detail. A live empty-GitHub
  config probe returned five Hacker News rows, one auth error object, and the
  same count on all rows.
- Semantic Scholar zero-hit responses are valid search results, not runtime
  failures. They now return an empty list so the AI aggregator can distinguish
  a legitimate empty window from provider failure. Vendor precision likewise
  requires AMD or MI-series context for `Instinct`, preventing ordinary
  "human instinct" prose from being labeled AMD.

### First-party and upstream evidence

- NVIDIA's current CUDA release notes are live at
  <https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html>; AMD's
  ROCm release stream is at
  <https://rocm.docs.amd.com/en/latest/about/release-notes.html>; Huawei Ascend
  publishes its document surface at <https://www.hiascend.com/document>.
  Live reads proved all three were retrievable but previously polluted by
  embedded application code or styles.
- Hugging Face documents Hub models, datasets, Spaces, and community surfaces
  at <https://huggingface.co/docs>; live calls to
  <https://huggingface.co/api/models> and
  <https://discuss.huggingface.co/search.json> returned current structured
  records without a browser or API key.
- GitHub's current REST documentation is at
  <https://docs.github.com/en/rest>; `gh` 2.96 exposed structured
  `search issues`, `search prs`, and preview `discussion list` in the observed
  environment.
- Upstream GitHub CLI issue
  <https://github.com/cli/cli/issues/8867> records the discussion-search gap
  and GraphQL search path. Design issue
  <https://github.com/cli/cli/issues/12810> specifies agent-friendly
  discussion command envelopes and pagination. Merged pull request
  <https://github.com/cli/cli/pull/13084> implements `discussion list`, JSON,
  search, pagination, explicit disabled-state handling, and tests. Repository:
  `cli/cli`; merge commit:
  `2bb24f9e7537464055d8471ddc9e9cc39a485d32`; observed branch/release
  environment: `gh` 2.96.0; search terms: `discussion search`, `discussion
list JSON`, `AI agents`, `pagination`.
- Lobsters' current search controller only permits the query, scope, order,
  page, and authenticity-token parameters; its HTML `/search` route is the
  verified public boundary used locally. Source inspected at commit
  `472c98ee42c8fa235d4649406298489166c40f6a`:
  <https://github.com/lobsters/lobsters/blob/472c98ee42c8fa235d4649406298489166c40f6a/app/controllers/search_controller.rb>.

### Local prevention

- Behavior tests lock HTTP extraction, browser extraction, malformed browser
  serialization, script/style removal, redirect canonicalization, vendor and
  source classification, reciprocal-rank fusion, source discovery, document
  structure, and Hugging Face forum topic/post joins.
- Regression tests also lock bilingual top-ranked discovery, AI category
  fast-path discovery, CLI/MCP transport parity, executable-auth metadata and
  guidance, filter-before-limit overfetch, community timestamps, paper
  identifier equivalence, repeated Atom authors, semantic document-body
  selection, and cancellation of HTTP/child-process work.
- Live freshness probes returned ISO source times from Hacker News, Lobsters,
  Stack Overflow, GitHub, Hugging Face, arXiv, and Semantic Scholar; a
  multi-community query with `--sort latest --since 2026-01-01` returned only
  timestamp-verifiable records in descending time order. Vendor negative
  probes prevent author-name `Cann`, ordinary English `ascend`, and continuous
  attractor neural-network `CANN` terminology from entering Huawei hardware
  results, while `CANN 8.5`, `Ascend 910 NPU`, MindIE, and official domains
  remain recognized.
- Live official-document freshness probes returned timestamp-verifiable 2026
  records for NVIDIA release notes and AMD ROCm/driver release notes. Huawei
  CANN 9.0 official results currently expose versioned content but no date in
  Yahoo's row; strict `--since` therefore reports that unsupported freshness
  state and offers an undated inspection/read path. The CANN 9.0 live read
  retained the actual release body while removing all observed
  `[object Object]`/`undefined` framework placeholders.
- Live probes lock the operational path for official NVIDIA documents,
  Hugging Face Hub/forum records, GitHub issues/discussions, keyless search,
  top-level discovery, structured reads, and partial-failure recovery.
- Unsupported states stay explicit: GitHub discussions require `OWNER/REPO`;
  private/authenticated content stays at its owning auth boundary; upstream
  rate limits are reported rather than silently replaced.

### Broad practitioner-source follow-up

- The registry had substantially more useful AI surfaces than `ai sources`
  exposed. OpenReview, OpenAlex, Crossref, ACL Anthology, X, Reddit, YouTube,
  Linux.do, Zhihu, Bilibili, and OpenRouter already had owned commands but no
  `ai.*` capability identity. The source federation now discovers them from
  registry metadata instead of duplicating their transport logic.
- Ten role profiles encode the recurring information needs observed in live
  source probes: foundation-model architecture/releases and post-training;
  training data/parallelism/optimizers/checkpoints; inference latency,
  throughput, KV cache, batching, quantization, kernels and schedulers; world
  models' video/3D/4D state, physics, interactive environments and spatial
  planning; embodied policies, simulation and deployment; hardware drivers,
  SDKs, compilers, memory/interconnect, compatibility, MLPerf and advisories;
  agent tool use/memory/protocols; evaluation/safety/security; and paper,
  review, rebuttal, code/data and reproducibility evidence.
- The maintained landscape covers 100 maintainer-owned targets across
  frontier and regional labs, model hubs, NVIDIA/AMD/Ascend and nine additional
  hardware ecosystems, training/inference runtimes, world-model and robotics
  organizations, literature venues, benchmarks, and community platforms. It
  selects a bounded set of primary domains by query and role. A platform's own
  catalog membership does not make arbitrary X, Reddit, YouTube, or other
  community posts first-party; exact maintainer domains and known GitHub
  repositories own that attribution.
- Uni-CLI live-read probes succeeded against 27 additional first-party landing
  surfaces spanning Runway, Luma, Pika, Kling, Moonvalley, Decart, Odyssey,
  Waabi, Field AI, Figure, 1X, Together, Fireworks, CoreWeave, Lambda, Nebius,
  Modal, Baseten, EleutherAI, Cambricon, Biren, Moore Threads, d-Matrix,
  Etched, FuriosaAI, Rebellions, and Graphcore. These verified domains extend
  the directory's world-model, robotics, AI-cloud, and accelerator coverage;
  they do not masquerade as dedicated native APIs where none was proven.
- Live Hugging Face daily papers, OpenReview world-model submissions, OpenAlex
  inference-system works, YouTube systems talks, Hacker News runtime/kernel
  posts, and authenticated X results proved that practitioners need papers,
  reviews, code changes, model/dataset cards, official documentation and
  release notes, talks, and high-signal discussion together. Reddit, Linux.do,
  and Zhihu correctly exposed their authentication boundaries rather than
  silently degrading to a different source.
- ModelScope's public OpenAPI returned current model and dataset rows from
  `/openapi/v1/models|datasets`. Its official SDK source was inspected at
  commit `a54673c25033b7edb7220f08525668d9bbcebddf`:
  <https://github.com/modelscope/modelscope_hub/blob/a54673c25033b7edb7220f08525668d9bbcebddf/src/modelscope_hub/_openapi.py>.
  Search terms: `openapi v1 models datasets search page_number page_size`.
- OpenCSG's public CSGHub API returned current model rows from
  `/api/v1/models|datasets` with the supported `trending`, `recently_update`,
  `most_download`, `most_favorite`, and `most_star` ordering vocabulary. The
  owning server was inspected at commit
  `f90524f09c9619167cdffd5ff5ba63843e3629fd`:
  <https://github.com/OpenCSGs/csghub-server/tree/f90524f09c9619167cdffd5ff5ba63843e3629fd/api>.
  Search terms: `api v1 models datasets search sort per page`.
- Bluesky's official `app.bsky.feed.searchPosts` lexicon was inspected at
  commit `0af78cf2b15a2b541f0f1889178ae64086d982f3`:
  <https://github.com/bluesky-social/atproto/blob/0af78cf2b15a2b541f0f1889178ae64086d982f3/lexicons/app/bsky/feed/searchPosts.json>.
  The working public app-view host in the observed environment was
  `api.bsky.app`; `public.api.bsky.app` returned HTTP 403 for this method.
  Upstream issues document incomplete OR behavior
  (<https://github.com/bluesky-social/atproto/issues/3751>), missing feed
  filtering (<https://github.com/bluesky-social/atproto/issues/3739>), omitted
  bridged accounts (<https://github.com/bluesky-social/atproto/issues/3968>),
  and cursor/403 failure states
  (<https://github.com/bluesky-social/atproto/issues/3583>,
  <https://github.com/bluesky-social/atproto/issues/3891>). The adapter therefore
  promises only one bounded plain-query page with source-provided timestamps.
- Replicate's former public `/api/v1/models?query=` boundary is no longer a
  valid unauthenticated model-search surface. Its official search announcement
  requires `GET https://api.replicate.com/v1/search` with a bearer token:
  <https://replicate.com/blog/new-search-api>. Replicate remains in the target
  directory but is not mislabeled as a working public federated source.
- `ai pulse` is deliberately an on-demand live snapshot, not a background
  monitor. A strict window retains only source- or explicitly index-dated rows;
  `--include-auth` is the explicit boundary for X, Reddit, Linux.do, Zhihu, and
  Bilibili. This gives agents current execution-time evidence without claiming
  zero upstream indexing delay or inventing timestamps.
- The completed built surface returns 10 practitioner profiles, 100 maintained
  primary-source targets, and 35 registry-discovered AI capability rows. Live
  ModelScope model/dataset, OpenCSG model, and Bluesky post probes returned
  structured current records; an empty OpenCSG dataset result remained a valid
  empty upstream state rather than a fabricated fallback.
- The live world-model pulse returned current Bluesky, Hacker News, and
  ModelScope evidence after phrase-noise filtering, cross-URL syndicated-title
  deduplication, and per-source diversity limiting. The live inference pulse
  completed in 14.17 seconds with five current results while preserving Brave,
  Yahoo, and OpenReview failures as structured partial errors.
- The full verification contract passed: 277 unit files with 3,064 tests
  passed and 3 skipped; 17 integration files passed with 94 tests passed and
  14 skipped; 170 adapter files passed with 6,515 tests; performance and
  targeted 100% coverage checks passed; all 992 adapters linted; adapter-test
  coverage was 74; stats, truth, conformance, exports, changesets, and the
  public boundary guard passed. The final catalog invariant refinement then
  passed its 28 focused command tests plus a fresh build, generated-doc check,
  stats check, format check, boundary check, and `git diff --check`.
