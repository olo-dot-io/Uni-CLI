# Schema-v2 (adapter schema migration)

Uni-CLI's adapter format is versioned. Schema-v1 is the legacy shape
shipped through v0.211. Schema-v2 lands in v0.212 with stricter typing,
quarantine metadata, and a capability-based step registry.

This doc covers: what v2 changes, how to migrate, how the lint engine
validates, and how CI gates it.

## What changed (v1 → v2)

| Field              | v1             | v2                                      |
| ------------------ | -------------- | --------------------------------------- |
| `site`             | string         | required, `^[a-z0-9-]+$`                |
| `name`             | string         | required, matches filename stem         |
| `type`             | 5 values       | 5 values, required at site level        |
| `strategy`         | 5 values       | 5 values + cascade hint                 |
| `pipeline`         | array of steps | non-empty array; every step name known  |
| `quarantine`       | — (implicit)   | explicit object                         |
| `quarantineReason` | —              | required when `quarantine: true`        |
| `args.<name>.type` | optional       | required; `str \| int \| float \| bool` |
| `columns`          | optional       | required when `pipeline` yields table   |
| `output`           | string or obj  | object, typed                           |

v1 adapters still load — the migration is gradual. `unicli lint` flags
v1-only fields as warnings; strict mode (nightly CI) promotes them to
errors.

## Known step names

The canonical list (v0.212): 35 steps. Source of truth is the switch in
`src/engine/yaml-runner.ts:148`. The lint engine reads the same registry.

| Category  | Steps                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| API       | `fetch`, `fetch_text`, `parse_rss`, `html_to_md`                                                              |
| Transform | `select`, `map`, `filter`, `sort`, `limit`                                                                    |
| Desktop   | `exec`, `write_temp`                                                                                          |
| Browser   | `navigate`, `evaluate`, `click`, `type`, `wait`, `intercept`, `press`, `scroll`, `snapshot`, `tap`, `extract` |
| Media     | `download`, `websocket`                                                                                       |
| Control   | `set`, `if`, `append`, `each`, `parallel`, `rate_limit`, `assert`, `retry`                                    |

Adding a new step:

1. Add a `case "<name>":` in `src/engine/yaml-runner.ts` switch.
2. Document semantics in the JSDoc at the top of the file.
3. Add the step to the capability matrix in `src/engine/capability.ts`
   (when Phase 1 lands) or the inline list in `src/commands/lint.ts`.
4. Add a unit test in `tests/unit/pipeline-*.test.ts`.
5. Update this doc's table.

## Quarantine

An adapter can be marked quarantined when it is known-broken but kept
for reference (e.g. API was deprecated upstream, site is being
migrated). Quarantined adapters are loaded but excluded from `unicli
list` by default.

```yaml
site: example
name: legacy-search
quarantine: true
quarantineReason: "Upstream API removed 2025-11-01; migrate to v2-search.yaml"
pipeline:
  - fetch: { url: https://example.com/api/v1/search }
```

The lint engine enforces:

- `quarantine: true` ⇒ `quarantineReason` must be non-empty.
- `quarantineReason` without `quarantine: true` is a warning.

## Lint engine

`unicli lint [path]` runs:

1. **Parse**: every YAML file under `src/adapters/` (or `path`) must
   parse with `js-yaml.load` and match the schema-v2 shape.
2. **Known steps**: every step name in `pipeline` is in the registry.
3. **No cycles**: `if` and `each` sub-pipelines cannot recurse into
   themselves by reference (BFS visit from each entry point).
4. **Quarantine integrity**: see rules above.

Non-zero exit on any failure. Used by `npm run verify` (Phase 8.8) and
the CI `verify` job.

```bash
npm run dev -- lint                 # lint all built-in adapters
npm run dev -- lint src/adapters/hackernews/   # lint one site
```

## CI gate

`.github/workflows/ci.yml` runs `unicli lint` inside the `verify` job on
every matrix cell. Failures block merge. Nightly strict mode (see
`adapter-health-strict`) additionally rejects v1-only fields.

## Migration workflow

For an existing v1 adapter:

1. Ensure `site`, `name`, `type` are explicit.
2. Add `type` on every arg.
3. If quarantined, add `quarantineReason`.
4. Run `npm run dev -- lint src/adapters/<site>/`.
5. Run `npm run test:adapter -- <site>` to confirm the schema change
   did not break execution.
6. Commit with `chore(adapter): migrate <site> to schema-v2`.

## Checklist

- [ ] All required v2 fields present.
- [ ] Every pipeline step name in the registry.
- [ ] `quarantine: true` adapters have `quarantineReason`.
- [ ] `unicli lint` returns 0.
- [ ] Changeset added.
