---
name: unicli-browser
description: >
  Control broker-owned hidden, existing-Chrome, or remote browser targets with
  explicit Agent identity, visibility, profile partitions, and lifecycle.
version: 2.0.0
triggers:
  - "browser automation"
  - "control chrome"
  - "unicli browser"
  - "background browser"
allowed-tools: [Bash]
protocol: 2.0
---

## When to Use

Use `unicli browser` for browser lifecycle, page interaction, session sharing,
target handoff, and diagnostics. `unicli operate` is a compatibility alias for
the page-action subset.

## Provider Decision

| Requirement                                  | Provider and visibility        |
| -------------------------------------------- | ------------------------------ |
| No window; default automation                | `managed` + `hidden` (default) |
| Existing signed-in Chrome tab, no activation | `chrome` + `background`        |
| Explicit user-visible Chrome interaction     | `chrome` + `foreground`        |
| Explicit cloud/browser service               | `remote` + `hidden`            |

No provider falls back to another. Managed and remote providers cannot become
foreground. Existing Chrome cannot promise hidden operation.

## Quick Start

```bash
unicli browser doctor --json             # Probe only; starts nothing
unicli browser broker start              # Start windowless control plane only
unicli browser start                     # Lazily start default managed hidden target
unicli browser open https://example.com
unicli browser state
unicli browser click <ref>
unicli browser screenshot ./page.png
unicli browser sessions --json
```

## Agent Sessions and Reuse

A stable Agent session owns targets across turns. Different Agent sessions use
different targets, while a shared profile partition can reuse login/storage.

```bash
unicli browser --session thread-42 --turn turn-1 open https://example.com
unicli browser --session thread-42 --turn turn-2 state
unicli browser --session thread-42 --turn turn-3 click 7
unicli browser sessions --json
unicli browser session-end thread-42
```

Use `--profile-partition team-login` to share storage deliberately. Use
`--isolated` for a disposable browser context inside that partition. `--workspace`
is a compatibility spelling for the same partition concept.

## Existing Chrome Without Foreground Activation

Install the native host and extension once, keep an existing normal Chrome
window open, list tabs, then claim a specific tab:

```bash
unicli browser native-host install
unicli browser --provider chrome --visibility background tabs
unicli browser --session thread-42 --provider chrome --visibility background bind 123
unicli browser --session thread-42 --turn turn-2 --provider chrome --visibility background state
```

Background allocation must preserve focused window and active-tab state. If
Chrome cannot satisfy that postcondition, the command fails instead of opening
or focusing a window. Use `--focus` only for an explicit foreground request.

## Broker Lifecycle

```bash
unicli browser broker status
unicli browser broker start
unicli browser broker restart
unicli browser broker stop
```

The broker is one authenticated, owner-only local control plane. Starting it
does not start Chrome. Browser processes are provider-owned and lazy. Session
TTL and target leases are visible through `browser status` and `browser
sessions`.

## Authentication and Profiles

```bash
unicli browser profiles --json
unicli browser cookies <domain> --profile-id <id>  # Explicit persistence
unicli auth import <site> --domain <domain>        # Explicit persistence
```

Managed runtimes use Uni-CLI-owned profiles under `~/.unicli/`; they never run
CDP against Chrome's default user-data-dir. A selected local profile seeds the
automation profile. `--ephemeral` explicitly selects an empty profile.

Chrome 136+ ignores remote-debugging switches on its default data directory.
`RemoteDebuggingAllowed=false` blocks even Uni-CLI automation profiles until an
administrator removes the policy or sets it true. The policy does not make the
default-profile CDP path supported.

## Remote Browser

```bash
export UNICLI_CDP_ENDPOINT='wss://browser.example/devtools/browser/...'
export UNICLI_CDP_HEADERS='{"Authorization":"Bearer ..."}'
unicli browser remote
unicli browser --provider remote --visibility hidden start
```

Status redacts credentials, paths, query tokens, and headers. Malformed remote
configuration is a hard error and never falls back locally.

## Page Workflow

1. `open` the URL.
2. `state` to obtain current refs.
3. Use `click`, `type`, `select`, or `keys` with those refs.
4. Run `state` again after navigation or DOM replacement.
5. Prefer captured JSON APIs when `network` reveals a stable endpoint.

Useful commands:

```bash
unicli browser find --css 'button'
unicli browser query 7 --kind attributes
unicli browser frames
unicli browser console
unicli browser network
unicli browser extract --chunk-size 8000
unicli browser evidence --render-aware
```

## Diagnostics

`unicli browser doctor --json` is the routing truth:

- `default_path`: managed/hidden availability and profile source.
- `broker`: stopped, running, or exact endpoint error.
- `providers`: managed runtimes, Chrome native-host state, redacted remote state.
- `sessions`: live Agent turns, target leases, and tombstones.
- `checks[*].next_step`: exact repairs.

`unicli browser doctor --repair` starts only the broker. It never starts a
browser provider and never creates an `about:blank` placeholder target.

| Problem                     | Exact next action                                                             |
| --------------------------- | ----------------------------------------------------------------------------- |
| Broker unavailable          | `unicli browser broker restart`                                               |
| Managed browser unavailable | Install Chrome or use explicit `--ephemeral`                                  |
| Chrome provider unavailable | Install native host/extension and keep a normal Chrome window open            |
| Remote config invalid       | Correct or unset `UNICLI_CDP_ENDPOINT` / `UNICLI_CDP_HEADERS`, restart broker |
| Exit 77                     | Restore auth with explicit profile/cookie flow                                |
