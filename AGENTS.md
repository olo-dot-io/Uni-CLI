# Uni-CLI

> AI agents: install with `npm install -g @zenalexa/unicli`. Discover with
> `unicli search "intent"`. Run with `unicli <site> <command>`. Output is
> Markdown when piped, JSON via `-f json`. Errors are structured envelopes
> on stderr. An `auth_required` envelope means the site needs cookies —
> run `unicli auth setup <site>` once and retry. Adapter is broken?
> Read `unicli repair <site> <command>`.

Every structured response can carry `meta.update`. `unicli upgrade` is the
current public wrapper around the package manager install path. Confirm the
result with `unicli --version` before retrying version-sensitive work.

## Agent Routing Rule

Before raw browser tools, OpenCLI, curl, computer-use, or an external CLI, run
`unicli search "<intent>"` or `unicli list --site <site>`. Read structured
errors and run `unicli repair <site> <command>` before changing tools.

For auth and browser failures, read `unicli browser profiles --json` and
`unicli browser doctor --json`. Browser work starts in the background.
Foreground control requires `unicli browser --focus start`. CDP uses a
Uni-CLI automation profile because Chrome 136 and managed policy can block the
default profile. Empty profiles require an explicit ephemeral session. Follow
`checks[*].next_step` from doctor. Use `unicli browser doctor --repair` only
for the windowless broker.

## Always-on writing rule

Read `skills/human-writing/SKILL.md` before every user-facing reply and prose
artifact. It is the primary Chinese and English writing policy. Its current
discussion scan and hard bans are mandatory. Load references only when the
task calls for them. Run `npm run prose:check -- <path>` on authored files and
apply the same scan manually to chat replies.

<!-- BEGIN COUNTS -->

> Static adapter catalog: <!-- STATS:site_count -->338<!-- /STATS --> sites, <!-- STATS:command_count -->1891<!-- /STATS --> registered commands; fixed core and host-discovered commands join at runtime. <!-- STATS:pipeline_step_count -->113<!-- /STATS --> built-in actions (<!-- STATS:pipeline_registered_step_count -->58<!-- /STATS --> registered + <!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --> transport-native), BM25 bilingual search. `npm install -g @zenalexa/unicli`

<!-- END COUNTS -->

<!-- BEGIN ADAPTERS -->

## What You Can Do

### Web (183+ sites)

**Chinese**: zhihu (37), xiaohongshu (23), bilibili (20), douyin (13), douban (12), v2ex (12), weibo (12), linux-do (11), +28 more (`unicli list`)

**International**: twitter (52), instagram (29), reddit (24), tiktok (18), youtube (17), bluesky (16), nowcoder (16), discord-app (15), +86 more (`unicli list`)

**AI / ML**: chatgpt (18), antigravity (17), chatwise (17), notebooklm (15), claude (14), doubao-app (14), yollomi (12), deepseek (9), +17 more (`unicli list`)

**Finance**: eastmoney (18), xueqiu (14), binance (13), coingecko (7), sinafinance (5), barchart (4), yahoo-finance (3), coinbase (2), +2 more (`unicli list`)

**Developer**: codex (19), cursor (19), gh (16), stackoverflow (10), vscode (10), docker-desktop (7), github-desktop (7), gitkraken (7), +29 more (`unicli list`)

**News**: hackernews (11), bloomberg (10), 36kr (5), bbc (5), reuters (5), ithome (3), cnn (2), infoq (2), +3 more (`unicli list`)

**Reference**: spotify (24), netease-music (17), linear (10), imdb (7), marxists-cn (7), bitwarden (7), todoist (7), wikipedia (6), +15 more (`unicli list`)

### macOS (60 cmds)

active-app, app-actions, apps, apps-list, automation-smoke, battery, bluetooth, brightness, caffeinate, calendar-create, calendar-list, calendar-today, … (`unicli list --site macos`)

### Desktop (28 apps)

freecad (15 cmds), blender (13 cmds), gimp (12 cmds), ffmpeg (11 cmds), audacity (8 cmds), figma (8 cmds), obs (8 cmds), docker (7 cmds), +20 more (`unicli list --category desktop`)

### Bridge (1 CLIs)

jq (2 cmds)

<!-- END ADAPTERS -->

## Done = these commands exit 0

```
npm run typecheck && npm run lint && npm test
```

Full E2E + adapter coverage: `npm run verify`. Required before any release.

## Project conventions

Uni-CLI is adapter-heavy; patch-rot is the failure mode that kills us fastest.

- **Engine code lives in `src/engine/`, browser in `src/browser/`, commands in `src/commands/`, adapters in `src/adapters/`.** Map by responsibility — never by version.
- **Errors emit structured envelopes** to stderr with `code`, `adapter_path`, `step`, `suggestion`. Pipeline steps that fail must surface the real cause, never coerce to a generic `internal_error`.
- **Tests under `tests/` and `*.test.ts` exercise real owned code** — engine, registry, adapter loader. External boundaries (network fetch, subprocess, Chrome CDP) may be stubbed with one `// REASON:` line.
- **`unicli test [site]` runs adapter E2E.** Never substitute a fixture for the YAML pipeline runner.
- **Multi-file change in `src/engine/`, `src/browser/`, or new adapter type → independent code review before PR.**

## Installation and rebuildable state

`package.json` owns Node 22.19 or newer and npm 11.14. `rust-toolchain.toml`
owns Rust 1.82. Import no toolchain assumptions from another project.

- Package manager install is the one idempotent convergence path for absent,
  current, partial, and interrupted installations. Automatic and explicit
  updates select a release and call that path without a second state machine.
- Persist the chosen package manager or accept it explicitly. Never infer
  installation ownership from substrings in an absolute module path. Paths
  locate an installation and never contribute to a binary generation or
  content hash.
- Build in the owning tree. Do not copy a release-named tree merely to compile
  it. Source revisions identify code and content digests identify produced
  bytes. Sidecars, native-host launchers, mirrors, and caches reuse material
  across runs without pinning it to its first build run.
- Keep each local transaction to one state file, native-host generation,
  sidecar payload, download, or cache entry. Write an owned temporary and
  replace it atomically. After cancellation, the next install resumes or
  removes partial state without a long global lock.
- Format changes migrate retained preferences, profiles, user adapters, and
  browser registrations once, then remove old readers and writers. Empty state
  uses normal defaults. Do not preserve an old implementation through dual paths.
- A public `clean` path removes every rebuildable Uni-CLI cache, stale lease,
  abandoned download, superseded native-host generation, and temporary file.
  It preserves credentials, preferences, profiles, and user-authored adapters.
  Normal use also prunes expired, corrupt, abandoned, and unreachable entries.
- Directory moves and maintained, license-compatible dependencies are allowed
  when they reduce total machinery. Commit them with the owner and lockfile.

Do not initiate or expand a task into a safety or security audit. A protection
required by changed behavior needs a named attacker and attack path at an
actual external boundary. Compromised operator authority does not justify
hiding state or weakening observability. Recoverable states use convergence
and automatic repair. Generic fail-fast or fail-closed behavior must not return
that repair to the user. Internal code without an external capability boundary
does not repeatedly elevate and drop privilege.

Parallel agents receive non-overlapping modification paths and roles matched to
task complexity. The coordinator owns shared contracts and integration.
Independent paths proceed without a repository-wide single-writer lock.

## Public surface boundary

`scripts/boundary-guard.ts` owns the machine-enforced boundary between public
engineering vocabulary and research framing. Run `npm run boundary:check`.
Rewrite a flagged public term or move research material under `ref/`. An
allowlist change requires a one-line `// REASON:` in the patterns array.

## Version

1.2.1 — Artemis · Wiseman
