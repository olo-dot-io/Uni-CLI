# Compute

`unicli compute` is the local computer-control surface. It routes each request
through the fastest available structured transport first, then falls back to
broader transports when needed.

Transport order is selected per verb and host platform:

- macOS: Accessibility first for app control, CDP for browser/Electron renderers,
  CUA as the visual fallback.
- Windows: UIA first once the sidecar is present, CDP next where available, CUA
  as fallback.
- Linux: AT-SPI first once the sidecar is present, CDP next where available,
  CUA as fallback.

## Snapshot, Find, Click

```bash
unicli compute snapshot --app Calculator --format compact
unicli compute find --role button --name 5
unicli compute find --role input --text 8 --first
unicli compute click @e7
```

Snapshots return compact element refs such as `@e7`. The latest ref bucket is
kept by the transport bus so follow-up actions can dereference aliases without
coordinates. When a structured transport reports bounds, the refs preserve
screen-relative coordinates and `screenIndex` so follow-up actions can target
the same monitor in multi-display setups.
When a snapshot node includes a visible/current value, compact output and stored
refs preserve it, and `compute find --text <text>` can match that value. This is
useful for calculator displays, address fields, editors, and status labels
whose value is not part of the accessible name.

## Commands

| Command                                           | Purpose                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| `compute apps`                                    | List running apps                                  |
| `compute windows --app <name>`                    | List windows                                       |
| `compute snapshot --app <name> --format compact`  | Capture a compact/tree/json accessibility snapshot |
| `compute find --role <role> --name/--text <text>` | Find matching refs by label or value               |
| `compute click <ref>`                             | Click a ref                                        |
| `compute type <ref> <text>`                       | Set or type text                                   |
| `compute press <combo>`                           | Send a key combo                                   |
| `compute scroll <ref>`                            | Scroll a ref                                       |
| `compute launch <app>`                            | Launch an app                                      |
| `compute screenshot [path]`                       | Capture a screenshot                               |
| `compute attach --app <name>`                     | Attach CDP to a renderer                           |
| `compute attach --app <name> --confirm-relaunch`  | Allow risky app relaunch for CDP attach            |
| `compute eval <js>`                               | Evaluate JS in an attached renderer                |
| `compute wait --ref <ref>`                        | Wait for an element/text/state                     |
| `compute observe <goal>`                          | Rank refs for a natural-language goal              |
| `compute assert --text <text>`                    | Assert visible state                               |

## Output

All commands use the normal Uni-CLI v2 envelope. Success writes to stdout; a
failed cascade writes a structured error to stderr with the failing transport
details and exits with the transport error code.

`compute launch <app>` is routed through the subprocess transport first. It uses
the host launcher command for the current OS: `open -a` on macOS,
`Start-Process` through PowerShell on Windows, and `gtk-launch` on Linux.
When `--debug-port <port>` is supplied, Uni-CLI passes
`--remote-debugging-port=<port>` to the launched app for Electron CDP attach
workflows. The native desktop fallbacks honor the same debug-port argument when
the subprocess route is not available.
The direct low-level UIA and AT-SPI sidecar `launch_app` actions are also
implemented for sidecar callers: UIA uses PowerShell `Start-Process`, and
AT-SPI uses `gtk-launch`. Cross-OS live launch smoke evidence is still pending.

```bash
unicli compute snapshot --app TextEdit -f json
```

Failures include a `minimum_capability` key and may include a structured
`remedy` with a command or deeplink. See
[Compute Troubleshooting](troubleshooting.md) for the remedy catalog.

## Live Smoke

Maintainers can generate the cross-OS smoke plan without touching the host:

```bash
npm run compute:smoke -- --json --platform linux
```

To execute it on a real target machine, run:

```bash
npm run compute:smoke -- --run --include-mutating --output smoke-report.json
```

The smoke harness uses a temporary ref store, checks `doctor compute`, lists
apps, launches the platform calculator app, captures a compact snapshot, finds a
button ref, waits for it, asserts it is enabled, clicks it with `--background`,
exercises type/scroll routing, and captures a screenshot. Omit
`--include-mutating` to skip launch/click/type/scroll steps while still
collecting read-only evidence. For richer text-field or scroll-container
coverage, override the app and target label with `--app` and `--button`.
When `--run` is used, the harness records every step's `ok`, `exit_code`,
duration, stdout, and stderr instead of aborting at the first failed command, so
cross-OS smoke artifacts keep enough evidence for repair. `--output` writes the
same schema-versioned report to disk for CI artifacts or manual release
evidence.

## Focus Stealing

Actuating commands prefer background mode: `compute click`, `compute type`,
`compute press`, and `compute scroll` pass `focus: false` to structured
transports unless `--focus` is set. CUA remains the visual last-resort fallback;
when the cascade reaches CUA, Uni-CLI treats the action as focus-taking because
the backend may move the cursor or active surface.

See [Compute Focus Behavior](focus-behavior.md) for the transport matrix and
source links.

Windows UIA uses native top-level inventory and live descendant traversal where
available. Refs emitted from Windows snapshot/find can target `compute type`,
`compute scroll`, `compute screenshot`, `compute wait`, and `compute assert`.
Wait/assert use role/name/title/app/pid filters and descendant text/value/state
checks when the UIA tree exposes them. `compute observe` ranks top-level and
descendant refs by goal/title/name token overlap and marks scrollable
descendants with `action: "scroll"` and slider/spinner/range descendants with
`action: "set_value"`. Descendant invoke, value, focus, and scroll actions
prefer native UIA patterns before bounded fallback paths; invoke also tries
toggle and selection item patterns for controls such as checkboxes, radio
buttons, and selectable list rows, while numeric set-value inputs can use
RangeValuePattern for sliders and spinners.
The UIA sidecar also supports direct app launch through PowerShell
`Start-Process`; the public compute launch cascade still tries subprocess first.

Linux AT-SPI uses `wmctrl -lG -p` where available and falls back to AT-SPI-only
top-level registry roots when `wmctrl` is missing or empty. Refs emitted from
Linux snapshot/find can target `compute click`, `compute type`, `compute
scroll`, `compute screenshot`, `compute wait`, `compute observe`, and
`compute assert`. Descendant click/type/focus prefer native AT-SPI
Action/Value/EditableText/Component proxies before bounded display-server
helpers; descendant scroll prefers native `Component.scroll_to(...)` before
helper fallback. `compute observe` marks scrollable descendants with
`action: "scroll"` and slider/spin-button/range descendants with
`action: "set_value"`. Descendant screenshots capture the element rectangle
when bounds are known. Top-level X11 screenshots use `import -window <id>` when
a real window id exists, and Wayland/top-level bounds use `grim -g` when bounds
are known.
The AT-SPI sidecar also supports direct app launch through `gtk-launch`; the
public compute launch cascade still tries subprocess first.

## CDP Attach

`compute attach --app <name>` resolves known Electron apps from the built-in
registry and uses the app's assigned debug port. If the endpoint is not already
listening, Uni-CLI launches the app with `--remote-debugging-port=<port>`,
reprobes CDP, and then reuses that renderer for `compute eval`, snapshot, click,
type, press, and scroll actions. App-based attach also persists the last CDP
session under the Uni-CLI compute state directory so a later `compute eval` from
a separate process can reconnect to the same renderer.

Some apps are marked as unsafe to relaunch automatically because restarting them
can interrupt signed-in workspace state. For those apps, attach refuses before
launching and returns a structured error; rerun with `--confirm-relaunch` only
when relaunching the app is acceptable.

See [Electron App Control](electron.md) for app caveats and registry guidance.

## Fallback Semantics

The cascade stops on the first successful transport result. Failed transports
are accumulated into one error envelope only when every candidate fails. This
keeps normal operation low-latency while preserving enough evidence for
`unicli doctor compute` and repair workflows.
