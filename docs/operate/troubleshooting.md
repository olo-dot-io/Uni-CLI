# Compute Troubleshooting

`unicli compute` failures include `minimum_capability` and, where known, a
structured `remedy`. Use this page when `unicli doctor compute` or a failed
compute command points at one of these keys.

## desktop-uia.binary_missing

Cause: the Windows UIA sidecar binary is not installed or is not on the expected
path.

Remedy: run `unicli doctor compute --install`, then retry the compute command.

Next action: use CDP-backed Electron/browser control or an explicit visual route after replanning.

## desktop-uia.startup_failed

Cause: the UIA sidecar started and exited before responding.

Remedy: run `UNICLI_TRACE=1 unicli doctor compute` and inspect antivirus,
Defender, or SmartScreen quarantine.

Next action: retry after reinstalling the sidecar package.

## desktop-uia.permission

Cause: Windows denied the UIA operation.

Remedy: run from an elevated terminal or install the sidecar with UIAccess.

Next action: use CDP for Electron/browser targets.

## desktop-uia.no_element

Cause: the saved ref no longer points at a live element.

Remedy: run `unicli compute snapshot` again, then retry with a fresh ref.

Next action: target by app/window and take a new snapshot.

## desktop-uia.not_invokable

Cause: the target element does not expose the UIA Invoke pattern.

Remedy: use `unicli compute type`, `unicli compute press`, or focus the control
first and retry.

Next action: select an explicit visual route after confirming that no semantic handle exists.

## desktop-uia.timeout

Cause: the UIA sidecar did not respond within the request timeout.

Remedy: retry the command; the sidecar boundary is designed to restart after
timeouts.

Next action: run `UNICLI_TRACE=1 unicli doctor compute` if the timeout repeats.

## desktop-uia.sidecar_crashed

Cause: the UIA sidecar process exited or closed its pipe while a request was in
flight.

Remedy: retry once. If it repeats, run
`UNICLI_TRACE=1 unicli doctor compute`.

Next action: use CDP for Electron/browser targets while inspecting sidecar logs.

## Windows UIA Native Scope

Current Windows UIA support has two layers:

- Top-level app/window inventory, snapshot, find, wait, observe, assert, focus,
  invoke, type, scroll, screenshot, and direct launch helpers use native
  Win32/UIA-adjacent calls such as `EnumWindows`, `SetForegroundWindow`,
  `SendInput`, HWND/GDI capture, and PowerShell `Start-Process`.
- Live descendant UIA traversal populates refs where the OS exposes a control
  tree. Descendant invoke, value, and focus actions prefer UIA patterns before
  provider-local bounded input mechanisms; descendant screenshot crops the owning window bitmap.

Stable top-level refs look like `desktop-uia:window-0x2b:Window[0]`. When passed to
wait, Uni-CLI polls the native top-level window inventory for a matching
role/name/title/app/pid filter until timeout. The HWND-bound scope prevents a
PID-local window reorder from changing the target. Observe ranks the same top-level
window refs by goal/title token overlap. Assert checks the same inventory for
top-level title text and visible/appear/enabled state.

## desktop-atspi.binary_missing

Cause: the Linux AT-SPI sidecar binary is not installed or is not on the
expected path.

Remedy: run `unicli doctor compute --install`, then retry.

Next action: use CDP-backed Electron/browser control or an explicit visual route after replanning.

## desktop-atspi.dbus_blocked

Cause: the AT-SPI bus daemon is not reachable.

Remedy: run `systemctl --user start at-spi-dbus-bus`.

Next action: restart the desktop session if the bus cannot be started.

## desktop-atspi.no_a11y_attr

Cause: the target app does not expose a usable AT-SPI tree.

Remedy: enable accessibility support for the app. Electron apps may need an
accessibility flag at launch.

Next action: use CDP for Electron/browser targets or explicitly replan to visual control.

## desktop-atspi.atspi_apps

Cause: the Linux top-level app inventory helper is missing or failed.

Remedy: ensure the AT-SPI bus is running. Uni-CLI prefers `wmctrl -lG -p` for
real X11 window ids and geometry, but can use AT-SPI-only registry
roots when `wmctrl` is missing or empty.

Next action: explicitly replan to CDP for an Electron/browser renderer or to a
visual route when no semantic handle exists.

## desktop-atspi.atspi_windows

Cause: the Linux top-level window inventory helper is missing or failed.

Remedy: install `wmctrl` when real X11 window ids are needed. On Wayland or
minimal environments, verify the AT-SPI bus is running so Uni-CLI can use
synthetic `atspi-root-N` windows from the accessibility registry.

Next action: inspect `compute route snapshot` with an exact target before
explicitly replanning.

## desktop-atspi.wayland-input

Cause: the selected AT-SPI provider is missing its Wayland input helpers.

Remedy: install `wtype` for text and printable key dispatch. Install `ydotool`
for supported modifier combos and Wayland scroll dispatch.

Next action: use structured AT-SPI actions that do not need synthetic input.

## desktop-atspi.x11-input

Cause: the selected AT-SPI provider is missing its X11 input helpers.

Remedy: install `xdotool` for text, key, and scroll dispatch.

Next action: use structured AT-SPI actions that do not need synthetic input.

## desktop-atspi.atspi_screenshot

Cause: no supported Linux screenshot helper is available, or the helper failed.

Remedy: install ImageMagick `import` for X11 top-level window capture, or
install `grim` for Wayland top-level bounds capture. Install
`gnome-screenshot` / `grim` for display-server capture.

Next action: use CDP for Electron/browser targets or explicitly replan to visual control.

## desktop-atspi.invalid_input

Cause: a Linux AT-SPI action received a `ref` or `stable` token that is not a
`desktop-atspi:window-<native-id>:Window[0]` exact-window token.

Remedy: run `unicli compute snapshot --format compact` or
`unicli compute find --first` on Linux, then retry with the fresh ref emitted by
the AT-SPI transport.

Next action: omit the ref to use the global helper path for text, scroll, or
screenshot actions when targeting the active desktop surface is acceptable.

## desktop-atspi.no_element

Cause: the saved ref no longer points at a live element.

Remedy: run `unicli compute snapshot` again, then retry with a fresh ref.

Next action: target by app/window and take a new snapshot.

## Linux AT-SPI Native Scope

Current Linux AT-SPI support has two layers:

- Top-level app/window inventory, snapshot, find, wait, observe, assert, focus,
  invoke, type, scroll, screenshot, and direct launch helpers use `wmctrl` when
  available, and AT-SPI-only synthetic windows when `wmctrl` is missing or
  empty. Synthetic windows use native AT-SPI focus rather than `wmctrl`.
- Descendant AT-SPI traversal populates role/name/value/state/bounds refs where
  the app exposes an accessibility tree. Descendant invoke, type, and focus
  prefer native Action/Value/EditableText/Component proxies, then use
  bounded display-server helpers owned by the same provider. Descendant scroll prefers native
  `Component.scroll_to(...)`, then uses provider-owned display-server wheel helpers.
- Screenshot uses `import -window <id>` for real X11 top-level window refs,
  `grim -g` for known Wayland/top-level bounds, and region capture for bounded
  descendant refs.

Stable top-level refs look like
`desktop-atspi:window-0x03a00007:Window[0]`. When passed
to type, scroll, or screenshot actions, Uni-CLI uses native operations when
available and activates the top-level window only for provider-owned helper actions. On X11
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

Next action: use CDP for Electron/browser targets while inspecting sidecar logs.

## desktop-ax.permission

Cause: macOS Accessibility is not granted to the app or terminal that launches
Uni-CLI.

Remedy: grant Accessibility in System Settings, then retry. Deeplink:
`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`.

Next action: CDP can still control browser/Electron renderers that expose a debug
port.

## desktop-ax.screen-recording

Cause: macOS Screen Recording is not granted. Native screenshot capture needs
this permission.

Remedy: grant Screen Recording in System Settings. Deeplink:
`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`.

Next action: prefer AX snapshots when the target exposes a structured tree.

## desktop-ax.binary_missing

Cause: the Swift runtime required by the macOS AX helper is not available.

Remedy: run `xcode-select --install`.

Next action: use CDP for browser/Electron targets.

## cdp-browser.attach_failed

Cause: the requested CDP port is not reachable.

Remedy: check the port, or start the browser transport with
`unicli browser start`.

Next action: use native AX/UIA/AT-SPI snapshots for non-browser app control.

## cdp-browser.electron_running_without_debug_port

Cause: the Electron app is running, but no remote debugging port is available.

Remedy: relaunch the app with a debug port, for example
`unicli compute launch <app> --debug-port 9229`.

Next action: use native AX/UIA/AT-SPI controls when the app exposes enough
accessibility structure.

## subprocess.launcher

Cause: the host launcher required by `compute launch` is unavailable. Uni-CLI
uses `/usr/bin/open` on macOS, PowerShell `Start-Process` on Windows, and
`gtk-launch` on Linux.

Remedy: restore the platform launcher. On Linux install GTK desktop utilities,
for example `sudo apt-get install libgtk-3-bin`.

Next action: start the app manually, then use `compute attach`, `compute snapshot`,
or the native desktop transport for follow-up actions.

## visual.no_backend

Cause: an explicit visual route was selected, but no visual backend endpoint or
credential is configured.

Remedy: set the generic visual backend environment:

```bash
export VISUAL_BACKEND=remote
export VISUAL_BACKEND_ENDPOINT=http://localhost:8800
export VISUAL_BACKEND_API_KEY=...
```

Next action: use structured AX/UIA/AT-SPI/CDP control where possible.

## compute.compute_find.ref-store

Cause: `compute find --first` could not find a matching ref in the current ref
store.

Remedy: run `unicli compute snapshot`, then retry the find with the new refs.

Next action: make the snapshot more specific with `--app`.

## compute.step.element_off_screen

Cause: the ref is valid, but the element bounds are outside the visible window
or screen.

Remedy: scroll the containing view into range, then take a fresh
`unicli compute snapshot`.

Next action: use `--focus` only when the app cannot expose a scrollable structured
container.

## compute.step.window_minimized

Cause: the target window is minimized or hidden, so the transport cannot act in
background mode.

Remedy: restore the window or retry the action with explicit focus.

Next action: use `unicli compute windows --app <name>` to choose a visible window.

## compute.step.element_disabled

Cause: the target element exists but is disabled.

Remedy: wait for it to become enabled with
`unicli compute wait --ref <ref> --state enabled`.

Next action: snapshot the surrounding UI and act on the prerequisite control.

## compute.step.ref_expired

Cause: the saved ref came from an older snapshot and no longer maps to a live
element.

Remedy: run `unicli compute snapshot`, then retry with the new ref.

Next action: use `compute find --first` after the new snapshot to select the ref.

## compute.step.sidecar_crashed

Cause: the UIA or AT-SPI sidecar exited while a call was in flight.

Remedy: retry once. If it repeats, run
`UNICLI_TRACE=1 unicli doctor compute`.

Next action: use CDP for Electron/browser targets while inspecting sidecar logs.

## compute.step.sidecar_busy

Cause: the sidecar is already processing a request.

Remedy: retry after the current call completes. Sidecar calls are serialized to
keep ref state stable.

Next action: avoid concurrent writes to the same app/window.

## compute.step.app_ambiguous

Cause: multiple running apps or windows match the same app name.

Remedy: run `unicli compute windows --app <name>` and retry with a more
specific bundle id, process name, pid, or window id.

Next action: target a CDP port or exact bundle id when controlling Electron apps.

## compute.step.focus_required

Cause: the transport cannot complete the action in background mode.

Remedy: retry with `--focus` only after confirming focus stealing is acceptable.

Next action: prefer a structured value/action path such as `compute type` or
`compute press` before enabling focus.

## compute.step.route_unavailable

Cause: the requested operation, route, platform, ref owner, and target evidence
have no declared compatible provider.

Remedy: inspect the decision with
`unicli compute route <operation> --params '<json>'`. Bind an exact target or
choose one compatible explicit route. The planner opens no provider.

## compute.step.provider_unavailable

Cause: route selection succeeded, then the selected provider failed to open or
dispatch.

Remedy: run `unicli doctor compute` and repair that provider. Uni-CLI did not
try another provider.

Next action: gather new target evidence and run `compute route` again when a
cross-provider replan is appropriate.

## overlaymacos_appkit

Cause: the macOS system HUD helper could not be parsed or launched. The overlay
path needs Swift, AppKit, a graphical desktop session, and the normal compute
permissions for app control and screenshot evidence.

Remedy: install Xcode command line tools with `xcode-select --install`, then
rerun `unicli doctor compute --json`. For real desktop app control, also grant
Accessibility and Screen Recording permissions to the terminal or host app.

Next action: run without `--overlay`; the compute action can still use AX/CDP and
return protocol-level `visual_timeline` replay evidence.

## overlaywindows_win32

Cause: the Windows system HUD helper could not be parsed or started. The overlay
path needs PowerShell, .NET Windows Forms, and an interactive desktop session so
Uni-CLI can create topmost click-through Win32 windows.

Remedy: rerun from a normal desktop session, then inspect
`unicli doctor compute --json`. If the UIA action transport is also failing,
install or repair the UIA sidecar package reported by doctor.

Next action: run without `--overlay`; Windows UIA actions and screenshot evidence
remain available when the sidecar and permissions are healthy.

## overlaylinux_gtk

Cause: the Linux system HUD helper could not be parsed or started. The overlay
path needs Python 3, PyGObject GTK 3, pycairo, and a graphical display session
where GTK can create keep-above input-shaped windows.

Remedy: install the GTK Python bindings for the distribution, then verify with:

```bash
python3 -c 'import cairo, gi; gi.require_version("Gtk", "3.0"); from gi.repository import Gtk'
unicli doctor compute --json
```

Next action: run without `--overlay`; Linux AT-SPI actions and screenshot evidence
remain available when the AT-SPI sidecar and display helpers are healthy.
