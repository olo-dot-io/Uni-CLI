# Compute Focus Behavior

`unicli compute` defaults semantic providers to `focus: false` for actuating
verbs. Use `--focus` or `focus: true` only when the selected provider requires
the target app to be brought forward. An explicitly selected visual route is
focus-taking.

The Browser Runtime Broker follows the same rule. Its default managed provider
runs hidden against a Uni-CLI-owned automation profile under `~/.unicli/`.
Existing Chrome is a separate provider: `background` creates or claims an
inactive tab in an existing normal window and verifies that focus and active-tab
state did not change; `foreground` is available only through explicit
`--focus`/`--visibility foreground`. Status, doctor, and session probes are
read-only and allocate no target or `about:blank` placeholder. The broker is
machine-scoped and reusable, while each Agent session owns distinct targets and
may opt into a shared login/storage partition.

## Defaults

One request selects one column before execution. Mechanisms listed inside a
column remain within that provider's target, permission, and error boundary.

| Verb                 | desktop-ax (macOS)                                                                  | desktop-uia (Windows)                                | desktop-atspi (Linux)                                        | cdp-browser                   | visual (explicit)            |
| -------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ | ----------------------------- | ---------------------------- |
| `compute click`      | AXPress, then pid/window-bounded background input when the same ref has coordinates | UIA Invoke/Toggle/Selection, then HWND-bounded input | AT-SPI Action, then target-bounded display input             | Attached renderer action      | Foreground coordinate action |
| `compute type`       | AXValue, then pid/window-bounded Unicode input                                      | UIA Value/RangeValue, then HWND-bounded input        | AT-SPI Value/EditableText, then target-bounded display input | Attached renderer action      | Foreground coordinate input  |
| `compute press`      | pid/window-bounded key event for an app-scoped target                               | UIA provider key dispatch                            | Display-server key dispatch owned by AT-SPI provider         | Attached renderer key event   | Foreground key event         |
| `compute scroll`     | AX scroll action                                                                    | UIA Scroll, then provider-owned wheel input          | AT-SPI Component scroll, then provider-owned wheel input     | Attached renderer wheel event | Foreground wheel event       |
| `compute screenshot` | Window/screen capture; Screen Recording may be required                             | Owning HWND bitmap or bounded crop                   | X11 window or Wayland bounded capture                        | Attached renderer capture     | Visual-provider capture      |

Source implementations: [desktop-ax](https://github.com/olo-dot-io/Uni-CLI/blob/main/src/transport/adapters/desktop-ax.ts),
[desktop-uia](https://github.com/olo-dot-io/Uni-CLI/tree/main/crates/unicli-uia/src),
[desktop-atspi](https://github.com/olo-dot-io/Uni-CLI/tree/main/crates/unicli-atspi/src),
[cdp-browser](https://github.com/olo-dot-io/Uni-CLI/blob/main/src/transport/adapters/cdp-browser.ts), and
[route planner](https://github.com/olo-dot-io/Uni-CLI/blob/main/src/transport/routing.ts).

## Operational Notes

- `compute click`, `compute type`, `compute press`, and `compute scroll` pass
  `focus: false` to AX, UIA, AT-SPI, and CDP unless the caller sets `--focus`
  or `focus: true`.
- `browser open`, `browser state`, `browser click`, `browser type`, and
  `browser screenshot` default to the hidden managed provider. Use
  `--background` for verified non-activating existing-Chrome control and
  `--focus` only for an explicit foreground action. `browser doctor`,
  `browser status`, and `browser sessions` inspect existing runtime state
  without starting a provider or allocating a target.
- Chrome 136+ disables remote debugging for the browser's default
  user-data-dir. Treat a process with `--remote-debugging-port` but no listening
  port as a default-profile launch defect, not a retryable CDP race. The
  correct repair is a process-verified live attach or a Uni-CLI-owned seeded
  automation profile selected from `unicli browser profiles --json`.
  `unicli browser doctor --json` reports this through profile-ownership and
  Chrome-policy checks. `unicli browser doctor --repair` starts only the
  windowless broker; `unicli browser --provider managed start` explicitly
  starts the safe hidden managed provider. The `profile_source` section reports
  seeded, explicit ephemeral, unavailable, and policy-blocked paths; the
  `chrome_remote_debugging` section also reports `RemoteDebuggingAllowed`:
  `false` blocks every local CDP path until the managed Chrome policy is
  removed or set true, while `true` still does not bypass the Chrome 136+
  default-directory restriction. Empty profiles require explicit
  `unicli browser start --ephemeral` or `UNICLI_BROWSER_EPHEMERAL=1`.
- macOS background input is not a global HID path. It resolves a running app
  and on-screen window, installs per-process event taps for the previous and
  target apps, sends an AppKit activation primer plus a center primer only when
  the target is not already frontmost, then posts events with target pid and
  window fields.
- The macOS background path uses Accessibility and Input Monitoring
  permissions. It may still fail for minimized, hidden, off-screen, disabled, or
  security-hardened windows; those failures remain structured errors rather
  than implicit foregrounding.
- Linux AT-SPI refs from `compute snapshot` / `compute find --first` can target
  `compute click`, `compute type`, `compute scroll`, `compute screenshot`,
  `compute wait`, `compute observe`, and `compute assert`. Descendant click,
  type, focus, scroll, and screenshot prefer native AT-SPI or bounded region
  operations before display-server helpers. Top-level X11 refs use `wmctrl`
  where a real window id exists; AT-SPI-only synthetic refs use the
  accessibility tree and native `ComponentProxy.grab_focus()`.
- Windows UIA refs from `compute snapshot` / `compute find --first` can target
  descendant click, type, focus, scroll, screenshot, wait, observe, and assert
  when the OS exposes the UIA tree. Invoke, toggle, selection, value, focus,
  and scroll prefer native UIA patterns before provider-local bounded input mechanisms.
- Linux AT-SPI `compute press` remains a global display-server helper path, so
  it targets the active desktop surface.
- The visual backend runs only after an explicit visual route is selected. Its
  coordinate actions use `focus: true` because they act on the visible desktop.
- If a target is minimized, hidden, disabled, or off screen, prefer a fresh
  `compute snapshot` and a structured retry before enabling `--focus`.
