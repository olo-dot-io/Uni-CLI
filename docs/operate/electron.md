# Electron App Control

`unicli compute attach` makes Electron renderers scriptable through Chrome
DevTools Protocol (CDP). Use it when accessibility snapshots miss web content
inside apps such as VS Code, Slack, Discord, Notion, Figma, GitHub Desktop, or
NeteaseMusic.

## Attach

```bash
unicli compute attach --app vscode
unicli compute eval "document.title"
```

Attach resolves the app in Uni-CLI's Electron registry, probes the assigned CDP
port, launches the app with `--remote-debugging-port=<port>` when the endpoint
is absent, then stores the active target under the compute state directory. A
later `compute eval`, snapshot, click, type, press, scroll, or wait command can
reuse that saved target from a separate process.

Use an explicit port when the app is already running with a custom CDP port:

```bash
unicli compute attach --port 9333
```

## Relaunch Safety

Apps marked with `relaunchLosesSession: true` require explicit confirmation:

```bash
unicli compute attach --app notion --confirm-relaunch
```

Use confirmation only when restarting that app is acceptable. Meeting apps,
workspace apps, and document apps can interrupt active calls, reconnect
workspaces, or refresh unsaved UI state during relaunch.

## App Caveats

| App             | Notes                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| VS Code         | Renderer CDP uses `--remote-debugging-port=<port>`. Extension-host inspection is separate. |
| Notion          | Requires `--confirm-relaunch` because workspace state can refresh.                         |
| Teams / Zoom    | Avoid relaunch during calls. Attach to an already-debug-enabled instance when possible.    |
| NeteaseMusic    | CDP-first inspection is preferred because the AX tree can be sparse.                       |
| Slack / Discord | CDP exposes channel and message content that desktop accessibility can miss.               |

## Manual Launch

The registry handles launch for known apps. For manual debugging or a custom
app, launch with a CDP port and then attach by port:

```bash
unicli compute launch Slack --debug-port 9241
unicli compute attach --port 9241
```

The equivalent host command on macOS is:

```bash
open -a "Slack" --args --remote-debugging-port=9241
unicli compute attach --port 9241
```

On Linux or Windows, start the app executable with the same
`--remote-debugging-port=<port>` argument, then run `compute attach --port`.

## Adding an App

Add a profile in `src/electron-apps.ts` with:

- unique `port`
- `processName`
- `bundleId` or `executableNames`
- `displayName`
- useful `aliases`
- `contentHints`
- `relaunchLosesSession: true` when relaunch can interrupt active user state

Verify the change with:

```bash
npx vitest run --project unit tests/unit/electron-apps-table.test.ts
unicli compute attach --app <id>
unicli compute eval "document.title"
```
