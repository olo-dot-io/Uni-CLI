# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue.**
2. Email: security@zenalexa.com (or use GitHub's private vulnerability reporting)
3. Include: description, reproduction steps, and impact assessment.
4. We will acknowledge within 48 hours and provide a fix timeline.

## Security Design Principles

### Credential Safety

- Uni-CLI **never** stores or transmits your credentials
- Browser commands reuse your Chrome login session via extension bridge
- Cookies never leave the browser process — they are used in-context via `evaluate()`
- No credentials are written to disk, logs, or telemetry

### Anti-Detection

- `navigator.webdriver` patching
- `window.chrome` stub
- Plugin list spoofing
- CDP frame cleanup from Error stack traces
- These measures protect your account from automated-access detection

### Adapter Sandbox

- YAML adapters execute in a restricted pipeline (fetch, map, filter, select)
- No arbitrary code execution from YAML — expressions are sandboxed
- TypeScript adapters have full access but are code-reviewed before merge
- User-contributed adapters in `~/.unicli/adapters/` are the user's responsibility

### Supply Chain

- Minimal runtime dependencies (7 packages)
- All dependencies are well-known, actively maintained packages
- `npm audit` runs in CI on every PR
