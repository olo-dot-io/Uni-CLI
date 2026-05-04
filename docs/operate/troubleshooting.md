# Compute Troubleshooting

`unicli compute` failures include `minimum_capability` and, where known, a
structured `remedy`. Use this page when `unicli doctor compute` or a failed
compute command points at one of these keys.

## desktop-uia.binary_missing

Cause: the Windows UIA sidecar binary is not installed or is not on the expected
path.

Remedy: run `unicli doctor compute --install`, then retry the compute command.

Fallback: use CDP-backed Electron/browser control or CUA screenshot fallback if
configured.

## desktop-uia.startup_failed

Cause: the UIA sidecar started and exited before responding.

Remedy: run `UNICLI_TRACE=1 unicli doctor compute` and inspect antivirus,
Defender, or SmartScreen quarantine.

Fallback: retry after reinstalling the sidecar package.

## desktop-uia.permission

Cause: Windows denied the UIA operation.

Remedy: run from an elevated terminal or install the sidecar with UIAccess.

Fallback: use CDP for Electron/browser targets.

## desktop-uia.no_element

Cause: the saved ref no longer points at a live element.

Remedy: run `unicli compute snapshot` again, then retry with a fresh ref.

Fallback: target by app/window and take a new snapshot.

## desktop-uia.not_invokable

Cause: the target element does not expose the UIA Invoke pattern.

Remedy: use `unicli compute type`, `unicli compute press`, or focus the control
first and retry.

Fallback: use CUA when no structured pattern is exposed.

## desktop-uia.timeout

Cause: the UIA sidecar did not respond within the request timeout.

Remedy: retry the command; the sidecar boundary is designed to restart after
timeouts.

Fallback: run `UNICLI_TRACE=1 unicli doctor compute` if the timeout repeats.

## desktop-uia.sidecar_crashed

Cause: the UIA sidecar process exited or closed its pipe while a request was in
flight.

Remedy: retry once. If it repeats, run
`UNICLI_TRACE=1 unicli doctor compute`.

Fallback: use CDP for Electron/browser targets while inspecting sidecar logs.

## Windows UIA Native Scope

Current Windows UIA support has two layers:

- Top-level app/window inventory, snapshot, find, wait, observe, assert, focus,
  invoke, type, scroll, screenshot, and direct launch helpers use native
  Win32/UIA-adjacent calls such as `EnumWindows`, `SetForegroundWindow`,
  `SendInput`, HWND/GDI capture, and PowerShell `Start-Process`.
- Live descendant UIA traversal populates refs where the OS exposes a control
  tree. Descendant invoke, value, and focus actions prefer UIA patterns before
  bounded fallback paths; descendant screenshot crops the owning window bitmap.

Stable top-level refs look like `desktop-uia:pid-1234:Window[0]`. When passed to
wait, Uni-CLI polls the native top-level window inventory for a matching
role/name/title/app/pid filter until timeout. Observe ranks the same top-level
window refs by goal/title token overlap. Assert checks the same inventory for
top-level title text and visible/appear/enabled state.

## desktop-atspi.binary_missing

Cause: the Linux AT-SPI sidecar binary is not installed or is not on the
expected path.

Remedy: run `unicli doctor compute --install`, then retry.

Fallback: use CDP-backed Electron/browser control or CUA screenshot fallback if
configured.

## desktop-atspi.dbus_blocked

Cause: the AT-SPI bus daemon is not reachable.

Remedy: run `systemctl --user start at-spi-dbus-bus`.

Fallback: restart the desktop session if the bus cannot be started.

## desktop-atspi.no_a11y_attr

Cause: the target app does not expose a usable AT-SPI tree.

Remedy: enable accessibility support for the app. Electron apps may need an
accessibility flag at launch.

Fallback: use CDP for Electron/browser targets or CUA screenshot fallback.

## desktop-atspi.atspi_apps

Cause: the Linux top-level app inventory helper is missing or failed.

Remedy: ensure the AT-SPI bus is running. Uni-CLI prefers `wmctrl -lG -p` for
real X11 window ids and geometry, but can fall back to AT-SPI-only registry
roots when `wmctrl` is missing or empty.

Fallback: target an Electron/browser app through CDP, or use CUA fallback.

## desktop-atspi.atspi_windows

Cause: the Linux top-level window inventory helper is missing or failed.

Remedy: install `wmctrl` when real X11 window ids are needed. On Wayland or
minimal environments, verify the AT-SPI bus is running so Uni-CLI can use
synthetic `atspi-root-N` windows from the accessibility registry.

Fallback: use `compute snapshot` on another transport or CUA fallback.

## desktop-atspi.wayland-input

Cause: Wayland input fallback tools are missing.

Remedy: install `wtype` for text and printable key dispatch. Install `ydotool`
for supported modifier combos and Wayland scroll fallback.

Fallback: use structured AT-SPI actions that do not need synthetic input.

## desktop-atspi.x11-input

Cause: X11 input fallback tools are missing.

Remedy: install `xdotool` for text, key, and scroll dispatch.

Fallback: use structured AT-SPI actions that do not need synthetic input.

## desktop-atspi.atspi_screenshot

Cause: no supported Linux screenshot helper is available, or the helper failed.

Remedy: install ImageMagick `import` for X11 top-level window capture, or
install `grim` for Wayland top-level bounds capture. Install
`gnome-screenshot` / `grim` for display-server fallback capture.

Fallback: use CDP for Electron/browser targets or CUA screenshot fallback.

## desktop-atspi.invalid_input

Cause: a Linux AT-SPI action received a `ref` or `stable` token that is not a
`desktop-atspi:pid-<pid>:Window[<n>]` top-level window token.

Remedy: run `unicli compute snapshot --format compact` or
`unicli compute find --first` on Linux, then retry with the fresh ref emitted by
the AT-SPI transport.

Fallback: omit the ref to use the global helper path for text, scroll, or
screenshot actions when targeting the active desktop surface is acceptable.

## desktop-atspi.no_element

Cause: the saved ref no longer points at a live element.

Remedy: run `unicli compute snapshot` again, then retry with a fresh ref.

Fallback: target by app/window and take a new snapshot.

## Linux AT-SPI Native Scope

Current Linux AT-SPI support has two layers:

- Top-level app/window inventory, snapshot, find, wait, observe, assert, focus,
  invoke, type, scroll, screenshot, and direct launch helpers use `wmctrl` when
  available, and AT-SPI-only synthetic windows when `wmctrl` is missing or
  empty. Synthetic windows use native AT-SPI focus rather than `wmctrl`.
- Descendant AT-SPI traversal populates role/name/value/state/bounds refs where
  the app exposes an accessibility tree. Descendant invoke, type, and focus
  prefer native Action/Value/EditableText/Component proxies, then fall back to
  bounded display-server helpers. Descendant scroll prefers native
  `Component.scroll_to(...)`, then falls back to display-server wheel helpers.
- Screenshot uses `import -window <id>` for real X11 top-level window refs,
  `grim -g` for known Wayland/top-level bounds, and region capture for bounded
  descendant refs.

Stable top-level refs look like `desktop-atspi:pid-1234:Window[0]`. When passed
to type, scroll, or screenshot actions, Uni-CLI uses native operations when
available and activates the top-level window only for helper fallbacks. On X11
with ImageMagick `import`, screenshot uses the resolved top-level window id
directly. On Wayland with `grim` and known bounds, screenshot captures the
reported rectangle. Assert checks top-level and descendant text/value/state
where the tree exposes them. Observe reports `action: "scroll"` for scroll
roles or scrollable states.

## desktop-atspi.sidecar_crashed

Cause: the AT-SPI sidecar process exited or closed its pipe while a request was
in flight.

Remedy: retry once. If it repeats, run
`UNICLI_TRACE=1 unicli doctor compute`.

Fallback: use CDP for Electron/browser targets while inspecting sidecar logs.

## desktop-ax.permission

Cause: macOS Accessibility is not granted to the app or terminal that launches
Uni-CLI.

Remedy: grant Accessibility in System Settings, then retry. Deeplink:
`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`.

Fallback: CDP can still control browser/Electron renderers that expose a debug
port.

## desktop-ax.screen-recording

Cause: macOS Screen Recording is not granted. This is only needed for screenshot
fallback.

Remedy: grant Screen Recording in System Settings. Deeplink:
`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`.

Fallback: prefer AX snapshots when the target exposes a structured tree.

## desktop-ax.binary_missing

Cause: the Swift runtime required by the macOS AX helper is not available.

Remedy: run `xcode-select --install`.

Fallback: use CDP for browser/Electron targets.

## cdp-browser.attach_failed

Cause: the requested CDP port is not reachable.

Remedy: check the port, or start the browser transport with
`unicli browser start`.

Fallback: use native AX/UIA/AT-SPI snapshots for non-browser app control.

## cdp-browser.electron_running_without_debug_port

Cause: the Electron app is running, but no remote debugging port is available.

Remedy: relaunch the app with a debug port, for example
`unicli compute launch <app> --debug-port 9229`.

Fallback: use native AX/UIA/AT-SPI controls when the app exposes enough
accessibility structure.

## subprocess.launcher

Cause: the host launcher required by `compute launch` is unavailable. Uni-CLI
uses `/usr/bin/open` on macOS, PowerShell `Start-Process` on Windows, and
`gtk-launch` on Linux.

Remedy: restore the platform launcher. On Linux install GTK desktop utilities,
for example `sudo apt-get install libgtk-3-bin`.

Fallback: start the app manually, then use `compute attach`, `compute snapshot`,
or the native desktop transport for follow-up actions.

## cua.no_backend

Cause: screenshot/VLM fallback is enabled in the cascade, but no backend API key
is configured.

Remedy: set a supported backend environment variable such as
`ANTHROPIC_API_KEY`, `TRYCUA_API_KEY`, or `OPENAI_API_KEY`.

Fallback: use structured AX/UIA/AT-SPI/CDP control where possible.

## compute.compute_find.ref-store

Cause: `compute find --first` could not find a matching ref in the current ref
store.

Remedy: run `unicli compute snapshot`, then retry the find with the new refs.

Fallback: make the snapshot more specific with `--app`.

## compute.step.element_off_screen

Cause: the ref is valid, but the element bounds are outside the visible window
or screen.

Remedy: scroll the containing view into range, then take a fresh
`unicli compute snapshot`.

Fallback: use `--focus` only when the app cannot expose a scrollable structured
container.

## compute.step.window_minimized

Cause: the target window is minimized or hidden, so the transport cannot act in
background mode.

Remedy: restore the window or retry the action with explicit focus.

Fallback: use `unicli compute windows --app <name>` to choose a visible window.

## compute.step.element_disabled

Cause: the target element exists but is disabled.

Remedy: wait for it to become enabled with
`unicli compute wait --state enabled`.

Fallback: snapshot the surrounding UI and act on the prerequisite control.

## compute.step.ref_expired

Cause: the saved ref came from an older snapshot and no longer maps to a live
element.

Remedy: run `unicli compute snapshot`, then retry with the new ref.

Fallback: use `compute find --first` after the new snapshot to select the ref.

## compute.step.sidecar_crashed

Cause: the UIA or AT-SPI sidecar exited while a call was in flight.

Remedy: retry once. If it repeats, run
`UNICLI_TRACE=1 unicli doctor compute`.

Fallback: use CDP for Electron/browser targets while inspecting sidecar logs.

## compute.step.sidecar_busy

Cause: the sidecar is already processing a request.

Remedy: retry after the current call completes. Sidecar calls are serialized to
keep ref state stable.

Fallback: avoid concurrent writes to the same app/window.

## compute.step.app_ambiguous

Cause: multiple running apps or windows match the same app name.

Remedy: run `unicli compute windows --app <name>` and retry with a more
specific bundle id, process name, pid, or window id.

Fallback: target a CDP port or exact bundle id when controlling Electron apps.

## compute.step.focus_required

Cause: the transport cannot complete the action in background mode.

Remedy: retry with `--focus` only after confirming focus stealing is acceptable.

Fallback: prefer a structured value/action path such as `compute type` or
`compute press` before enabling focus.

## compute.step.no-transport-available

Cause: every transport in the compute cascade failed or was unavailable for the
requested step.

Remedy: run `unicli doctor compute` and fix the first failing host transport.

Fallback: choose a narrower transport directly when possible, such as CDP for a
debuggable Electron renderer.
