# Versioning

Uni-CLI follows semver while the package is still in the `0.x` line.

## Rules

| Change                                                            | Version bump |
| ----------------------------------------------------------------- | ------------ |
| Adapter fixes, docs, tests, small command additions               | Patch        |
| New transport, new protocol surface, broad output behavior change | Minor        |
| Stable 1.0 compatibility contract or breaking public behavior     | Major        |

Current release: `0.215.1`.

## Source Of Truth

| File              | Purpose                             |
| ----------------- | ----------------------------------- |
| `package.json`    | npm package version                 |
| `CHANGELOG.md`    | release notes                       |
| `README.md`       | public install and capability entry |
| `AGENTS.md`       | agent command contract              |
| `docs/TASTE.md`   | public docs style/version check     |
| `docs/ROADMAP.md` | current engineering direction       |

Release scripts update and verify these files:

```bash
npm run build
npm run release:check
npm run verify
```

## Manual Bump

```bash
npm version VERSION --no-git-tag-version
npm run build
npm run release:check
```

Do not add version lore to README. Users need the package version, install
command, behavior contract, and migration path when behavior changes.
