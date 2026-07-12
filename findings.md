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
