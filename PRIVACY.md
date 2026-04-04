# Privacy Policy

## What Uni-CLI Collects

**Nothing.** Uni-CLI does not collect, transmit, or store any user data.

- No analytics or telemetry
- No crash reporting
- No usage tracking
- No network calls except those explicitly initiated by your commands

## Browser Session Reuse

Browser-based adapters (`strategy: cookie`) reuse your Chrome/Chromium login session through the Browser Bridge extension. This means:

- **Your cookies stay in Chrome** — they are never extracted, copied, or transmitted
- **API calls happen inside the browser context** — via `page.evaluate()`, not from Node.js
- **No credentials are stored** — not on disk, not in memory beyond the command execution
- **No third-party services** — all communication is between the CLI, the local daemon, and your browser

## YAML Adapters

YAML adapter pipelines execute `fetch` calls to the URLs specified in the adapter definition. These are the same HTTP requests your browser would make when visiting the site. No additional data is sent.

## Plugin Privacy

Third-party plugins may have their own privacy practices. Review plugin source code before installation. Uni-CLI's plugin system does not add any data collection on top of what plugins themselves do.

## Questions

If you have privacy concerns, please open an issue or contact security@zenalexa.com.
