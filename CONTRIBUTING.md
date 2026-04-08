# Contributing to Uni-CLI

Thank you for your interest in contributing to Uni-CLI! This guide covers the three main types of contributions.

## Types of Contributions

### A) New Adapters (Most Impactful)

Adding a new adapter is the fastest way to contribute. Most adapters are just 20-40 lines of YAML.

**YAML adapter** (preferred for simple cases):

1. Create a directory: `src/adapters/<site>/`
2. Add YAML files for each command: `<command>.yaml`
3. Test: `npm run dev -- <site> <command>`
4. Add tests: `tests/adapter/<site>.test.ts`
5. Update `registry.json` if you want it listed on the Hub

**TypeScript adapter** (for complex logic):

1. Create `src/adapters/<site>/<command>.ts`
2. Use the `cli()` registration helper from `registry.ts`
3. Follow existing patterns in `src/adapters/`

### B) Core Features

- Open an issue first to discuss the feature
- Follow existing code patterns
- Include tests for any new functionality
- Run `npm run verify` before submitting

### C) Bug Fixes

- Reference the related issue in your PR
- Include a test that reproduces the bug
- Ensure all existing tests still pass

## Adapter Types

| Type      | Use When                                        |
| --------- | ----------------------------------------------- |
| `web-api` | Target has a REST API (public or authenticated) |
| `desktop` | Target is a local desktop application           |
| `browser` | Requires full browser automation                |
| `bridge`  | Wrapping an existing CLI tool                   |
| `service` | Target is an HTTP service (local or remote)     |

## Development Setup

```bash
git clone https://github.com/olo-dot-io/Uni-CLI.git
cd Uni-CLI
npm install
npm run dev -- list              # Verify setup
npm run dev -- hackernews top    # Test a built-in adapter
```

## Code Style

- TypeScript strict mode — no `any` unless unavoidable
- All commands support `--format json` for machine-readable output
- YAML adapters preferred over TypeScript for simple API calls
- Exit codes follow sysexits.h conventions

## Testing

```bash
npm run test                     # Unit tests
npm run test:adapter             # Adapter integration tests
npm run verify                   # Full verification (format + tsc + lint + test + build)
```

## Commit Messages

Use conventional commits:

```
feat: add Bilibili video search adapter
fix: resolve cookie extraction on macOS Chrome
docs: add desktop adapter guide
test: add unit tests for YAML pipeline runner
```

## Contributor License Agreement

By submitting a pull request or otherwise contributing to this project, you agree to the terms of our [Contributor License Agreement](CLA.md). This agreement grants the project maintainer the necessary rights to distribute and sublicense your contributions as part of the project.

Please review the CLA before submitting your first contribution.

## Submitting a Pull Request

1. Fork the repo and create a feature branch from `main`
2. Make changes following the guidelines above
3. Run `npm run verify` — all checks must pass
4. Push and open a PR against `main`

## Questions?

Open a [Discussion](https://github.com/olo-dot-io/Uni-CLI/discussions) or an issue tagged `question`.
