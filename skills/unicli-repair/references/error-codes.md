# Error Envelope Reference

Source of truth: `src/core/envelope.ts`, `src/engine/repair/remedies.ts`,
`src/engine/repair/failure-classifier.ts`. This file mirrors them so an
agent in repair flow does not need to read the engine source.

## Envelope shape

```ts
type Envelope<T> =
  | { ok: true; data: T; elapsedMs?: number }
  | { ok: false; error: EnvelopeError; elapsedMs?: number };

interface EnvelopeError {
  transport: TransportKind; // "fetch" | "cdp-browser" | "subprocess" | "cua" | "http" | "desktop-*" | ...
  adapter_path?: string; // relative to repo or ~/.unicli/adapters
  step: number; // 0-indexed pipeline step
  action: string; // step kind: "fetch", "select", "map", "click", ...
  reason: string; // short token, drives exit_code
  suggestion: string; // human-actionable hint
  remedy?: EnvelopeRemedy; // attached for known capability codes
  minimum_capability?: string; // e.g. "desktop-uia.no_element"
  diff_candidate?: string; // unified-diff hint when the engine has one
  retryable: boolean; // true for transient (timeout, 5xx, sidecar restart)
  exit_code: number; // sysexits.h
}

interface EnvelopeRemedy {
  message: string; // one-line fix hint
  command?: string; // bash command to run
  deeplink?: string; // OS-level URL (macOS prefs panes)
  doc?: string; // path to docs/operate/troubleshooting.md anchor
}
```

## Sysexits exit codes

Exact constants live in `EnvelopeExit`. Use them to decide whether to
retry vs fix vs reconfigure.

| Code | Constant              | Meaning               | Default move                                                                 |
| ---- | --------------------- | --------------------- | ---------------------------------------------------------------------------- |
| 0    | `SUCCESS`             | OK                    | nothing                                                                      |
| 1    | `GENERIC_ERROR`       | unclassified          | classify by message + status; usually `selector_miss` or `unknown`           |
| 2    | `USAGE_ERROR`         | wrong args            | fix the invocation; not the adapter                                          |
| 66   | `EMPTY_RESULT`        | pipeline ran, 0 rows  | not always a bug; check the source has data; if persistent → `api_versioned` |
| 69   | `SERVICE_UNAVAILABLE` | upstream down         | retry with backoff; if persistent → check site status, not adapter           |
| 75   | `TEMP_FAILURE`        | transient timeout     | retry once; then escalate                                                    |
| 77   | `AUTH_REQUIRED`       | login expired/missing | `unicli auth setup <site>`, retry                                            |
| 78   | `CONFIG_ERROR`        | misconfigured tool    | apply `error.remedy.command`; usually `unicli doctor compute`                |

## `error.reason` tokens

The classifier maps these short tokens to exit codes. Recognise them in
output:

| Token                                | Maps to |
| ------------------------------------ | ------- |
| `success`                            | 0       |
| `usage_error`                        | 2       |
| `empty_result`                       | 66      |
| `service_unavailable`, `unavailable` | 69      |
| `temp_failure`, `timeout`            | 75      |
| `auth_required`, `auth`              | 77      |
| `config_error`, `config`             | 78      |
| (anything else)                      | 1       |

## `EnvelopeRemedy` catalog (capability → fix)

Indexed by `error.minimum_capability`. The engine attaches the remedy
automatically; surfaces here as a quick map. Full doc anchors live under
`docs/operate/troubleshooting.md`.

### Desktop AT-SPI (Linux)

| Capability                      | Fix                                            |
| ------------------------------- | ---------------------------------------------- |
| `desktop-atspi.binary_missing`  | `unicli doctor compute --install`              |
| `desktop-atspi.dbus_blocked`    | `systemctl --user start at-spi-dbus-bus`       |
| `desktop-atspi.no_a11y_attr`    | Enable accessibility support in the target app |
| `desktop-atspi.wayland-input`   | `sudo apt install ydotool`                     |
| `desktop-atspi.x11-input`       | `sudo apt install xdotool`                     |
| `desktop-atspi.no_element`      | `unicli compute snapshot` (ref expired)        |
| `desktop-atspi.sidecar_crashed` | `UNICLI_TRACE=1 unicli doctor compute`         |

### Desktop UIA (Windows)

| Capability                    | Fix                                                 |
| ----------------------------- | --------------------------------------------------- |
| `desktop-uia.binary_missing`  | `unicli doctor compute --install`                   |
| `desktop-uia.startup_failed`  | `UNICLI_TRACE=1 unicli doctor compute`              |
| `desktop-uia.permission`      | Run from elevated terminal or install with UIAccess |
| `desktop-uia.no_element`      | `unicli compute snapshot`                           |
| `desktop-uia.not_invokable`   | Use set-value or keyboard press instead of Invoke   |
| `desktop-uia.timeout`         | Retry once; sidecar auto-restarts                   |
| `desktop-uia.sidecar_crashed` | `UNICLI_TRACE=1 unicli doctor compute`              |

### Desktop AX (macOS)

| Capability                    | Fix                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `desktop-ax.permission`       | Open `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` |
| `desktop-ax.screen-recording` | Open Privacy → Screen Recording pane                                                 |
| `desktop-ax.binary_missing`   | `xcode-select --install`                                                             |

### CDP / Browser

| Capability                                        | Fix                                                |
| ------------------------------------------------- | -------------------------------------------------- |
| `cdp-browser.attach_failed`                       | Check the CDP port; relaunch with remote debugging |
| `cdp-browser.electron_running_without_debug_port` | `unicli compute launch <app> --debug-port 9229`    |

### CUA / Compute

| Capability                              | Fix                                          |
| --------------------------------------- | -------------------------------------------- |
| `cua.no_backend`                        | Configure a CUA backend key for VLM fallback |
| `compute.<step>.no-transport-available` | `unicli doctor compute`                      |
| `compute.compute_find.ref-store`        | `unicli compute snapshot`, then retry find   |

### Compute edge cases (suffix on `minimum_capability`)

| Suffix               | Fix                                                     |
| -------------------- | ------------------------------------------------------- |
| `element_off_screen` | `unicli compute snapshot` (scroll into view)            |
| `window_minimized`   | Restore or focus the target window                      |
| `element_disabled`   | `unicli compute wait --state enabled`                   |
| `ref_expired`        | `unicli compute snapshot`                               |
| `sidecar_crashed`    | `UNICLI_TRACE=1 unicli doctor compute`                  |
| `sidecar_busy`       | Retry after current sidecar call completes              |
| `app_ambiguous`      | `unicli compute windows --app <name>`                   |
| `focus_required`     | Retry with explicit focus only if background impossible |

## Failure types (classifier)

Source: `src/engine/repair/failure-classifier.ts`. The classifier reads
`error.code`, `error.message`, and any captured `networkRequests[].status`.

| Type            | Triggered by                                                                                                                            | Pre-action                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `selector_miss` | `code=SELECTOR_MISS` OR message contains "selector" / "element not found" / "not found in dom"                                          | —                            |
| `auth_expired`  | network status 401 OR 403 OR message contains "unauthorized" / "forbidden" / "login"                                                    | `unicli auth setup <site>`   |
| `api_versioned` | network status 404 with `/api`, `/v\d+`, `/graphql`, `/rest`, `/endpoint` in URL; OR message contains "unexpected" / "schema" / "shape" | —                            |
| `rate_limited`  | network status 429 OR message contains "rate limit" / "too many requests" / "throttle"                                                  | —                            |
| `unknown`       | anything else                                                                                                                           | re-run with `UNICLI_TRACE=1` |

A bare 404 without an API-style path is **not** classified as
`api_versioned` — it falls through to `unknown` so the agent does not
chase a phantom schema change on a generic dead URL.
