# Migrating Adapters From OpenCLI

> A field-by-field guide to importing OpenCLI YAML adapters into Uni-CLI
> v2. Includes the migration tool, known differences, and unsupported
> features.

Uni-CLI and OpenCLI share the "CLI-as-agent-interface" thesis and the
YAML-pipeline adapter shape. The formats are close enough that the
majority of OpenCLI YAML converts cleanly; the differences live in the
transport abstraction, the schema-v2 metadata block, and a handful of
pipeline step renames.

## The migration tool

```bash
unicli import opencli-yaml <path>                  # print Uni-CLI YAML to stdout
unicli import opencli-yaml <path> -o <out>         # write to file
unicli import opencli-yaml <path> --json-report    # also emit a JSON report to stderr
```

The tool is deterministic and idempotent. Same input → same output
byte-for-byte. Unknown OpenCLI fields are reported to stderr and
preserved under `_opencli_extra` in the output for manual review.

To migrate a directory of adapters in bulk:

```bash
for f in ~/.opencli/adapters/*/*.yaml; do
  out="src/adapters/$(basename $(dirname "$f"))/$(basename "$f")"
  mkdir -p "$(dirname "$out")"
  unicli import opencli-yaml "$f" -o "$out"
done
unicli migrate schema-v2 src/adapters   # fill v2 defaults for anything the import missed
unicli test                             # sanity-check the imported batch
```

## Field mapping

| OpenCLI field                       | Uni-CLI field                    | Notes                                                                          |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `site`                              | `site`                           | identical                                                                      |
| `name`                              | `name`                           | identical                                                                      |
| `description` / `summary`           | `description`                    | both OpenCLI aliases map to `description`                                      |
| `type`                              | `type`                           | identical but kept only for back-compat; `transport` is the v2 source of truth |
| `auth` / `authentication`           | `strategy`                       | value mapping below                                                            |
| `args` / `arguments` / `parameters` | `args`                           | identical shape; all three OpenCLI aliases collapse to `args`                  |
| `pipeline` / `steps`                | `pipeline`                       | both OpenCLI aliases collapse to `pipeline`                                    |
| `columns` / `output_columns`        | `columns`                        | identical                                                                      |
| `rate_limit` / `throttle`           | `rate_limit`                     | identical shape                                                                |
| _anything else_                     | preserved under `_opencli_extra` | warning emitted to stderr                                                      |

### Auth → strategy value mapping

| OpenCLI `auth` value                        | Uni-CLI `strategy`      |
| ------------------------------------------- | ----------------------- |
| `none` / `anonymous` / `public`             | `public`                |
| `cookie` / `cookies`                        | `cookie`                |
| `csrf` / `csrf_token` / `header` / `bearer` | `header`                |
| `xhr` / `intercept`                         | `intercept`             |
| `ui` / `browser_ui`                         | `ui`                    |
| _anything else_                             | `public` (with warning) |

### Strategy → transport inference

The v2 schema splits the old `strategy` field into a pure auth-hint
(kept as `strategy` for one release) and a transport key:

| `strategy`                     | `transport`   |
| ------------------------------ | ------------- |
| `public` / `cookie` / `header` | `http`        |
| `intercept` / `ui`             | `cdp-browser` |

The migration tool writes both fields. You can hand-edit to target
`desktop-ax` / `desktop-uia` / `desktop-atspi` / `cua` transports after
the import; the tool does not attempt to infer those.

## Pipeline step renames

The migration tool renames common OpenCLI step names to their Uni-CLI
equivalents:

| OpenCLI step                          | Uni-CLI step |
| ------------------------------------- | ------------ |
| `http` / `request` / `get` / `post`   | `fetch`      |
| `xpath` / `jsonpath`                  | `select`     |
| `extract` / `transform`               | `map`        |
| `keep` / `drop`                       | `filter`     |
| `slice` / `take`                      | `limit`      |
| `run` / `shell`                       | `exec`       |
| `open` / `visit` / `goto`             | `navigate`   |
| `watch` / `capture`                   | `intercept`  |
| `snapshot_dom` / `accessibility_tree` | `snapshot`   |

Every rename is reported in the `renamed_steps` field of the JSON report.

## Schema-v2 metadata defaults

The migration tool fills these new fields automatically:

| Field                | Default during import                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities`       | inferred from the actual pipeline step names                                                                                       |
| `minimum_capability` | derived from `transport` + observed steps (`http.fetch` \| `cdp-browser.navigate` \| `cdp-browser.intercept` \| `subprocess.exec`) |
| `trust`              | `public`                                                                                                                           |
| `confidentiality`    | `public` if `strategy: public`, else `internal`                                                                                    |
| `quarantine`         | `false`                                                                                                                            |

Hand-tune these after import if the defaults do not fit. Common
reasons to change:

- Set `trust: user` if the adapter came from a third-party contribution
  you have not reviewed.
- Set `confidentiality: private` for adapters that read the user's
  personal timeline / DMs / account settings.
- Set `quarantine: true` with a `quarantineReason` if the first smoke
  test fails.

## Differences in semantics

### Retry and backoff

OpenCLI's `request` step has a built-in `retries: N` option. Uni-CLI's
`fetch` step inherits retries from the runner-level `retry` property:

```yaml
# OpenCLI
- request: { url: "...", retries: 3, backoff: exponential }

# Uni-CLI v2
- fetch:
    url: "..."
  retry: { attempts: 3, backoff: exponential }
```

The migration tool leaves retry config on the step for now; re-run
`unicli migrate schema-v2` to normalise it to the v2 property syntax.

### Filter predicate syntax

OpenCLI accepts both `keep` (retain matching) and `drop` (remove
matching). Uni-CLI uses `filter` only, with explicit predicate semantics
(retain matching). The migration tool rewrites `drop: "<pred>"` to
`filter: "not (<pred>)"` automatically.

### Cookie extraction

OpenCLI reads cookies from `~/.opencli/cookies/<site>.json`. Uni-CLI
reads from `~/.unicli/cookies/<site>.json`. Same JSON shape. Migrate
your cookies file with:

```bash
mkdir -p ~/.unicli/cookies
cp ~/.opencli/cookies/<site>.json ~/.unicli/cookies/<site>.json
```

Or re-capture via `unicli auth setup <site>`.

### Templating

Both use `{{ expr }}` substitution inside YAML string values. Uni-CLI
additionally accepts the `${{ expr }}` form (preferred; unambiguous with
shell variables in embedded docs). The migration tool leaves the
existing `{{ }}` form in place — both work.

## Unsupported OpenCLI features

| Feature                                                    | Status          | Why                                                                                                                          |
| ---------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Plugin authoring via Python `plugin.py`                    | not supported   | Uni-CLI plugins are TypeScript; see `src/plugin/` and `docs/PLUGINS.md`. Port the Python logic to TS.                        |
| `wasm` pipeline step                                       | not supported   | No wasm runtime bundled. Use `exec` with a wasm host, or a TS adapter.                                                       |
| `composite` pipeline step (OpenCLI sub-adapter invocation) | partial support | Use `unicli` via the `exec` step for now; first-class subroutines land in v0.213.                                            |
| Non-YAML adapter formats (JSON, TOML)                      | not supported   | YAML is the canonical adapter format. Convert first with `yq` or similar.                                                    |
| Remote adapter registries                                  | partial         | `unicli adapter install <spec>` hits the canonical registry; custom registries require env override (`UNICLI_REGISTRY_URL`). |
| Built-in scraping heuristics (autoselect, autotitle)       | not supported   | These were non-deterministic and caused silent drift. Users write explicit `map`/`select` instead.                           |

## Reporting issues

Open an issue at `https://github.com/olo-dot-io/Uni-CLI/issues` with:

- The OpenCLI YAML you tried to import (redact cookies/tokens).
- The output of `unicli import opencli-yaml <path> --json-report` (warnings).
- What you expected vs. what you got.

For straightforward field-mapping gaps, the fix is usually a one-line
addition to `OPENCLI_FIELD_MAP` or `STEP_RENAME` in
`src/commands/migrate.ts` — PRs welcome.
