<!-- Generated from docs/guide/browser-desktop.md. Do not edit this copy directly. -->

# Browser And Desktop

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/browser-desktop
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/browser-desktop.md
- Section: Use Uni-CLI
- Parent: Use Uni-CLI (/guide/)

Uni-CLI groups browser and desktop actions under stable command families. Start with a state read, select a concrete target, then perform the action.

## Browser sessions

Check the local setup.

```bash
unicli browser doctor --json
```

Start a hidden managed browser.

```bash
unicli browser start
```

Use an existing Chrome session in the background.

```bash
unicli browser --background start
```

Open a page and inspect its accessible state.

```bash
unicli browser open https://example.com
unicli browser state -f json
```

The state response assigns refs to interactive elements. Pass a ref to actions such as `click`, `type`, and `query`.

```bash
unicli browser click <ref>
unicli browser type <ref> "search text"
```

## Desktop applications

Search by the result you want.

```bash
unicli search "inspect a desktop application" --surface desktop
```

Read compute health before the first desktop session.

```bash
unicli doctor compute --json
```

Take a snapshot, then act on a returned ref.

```bash
unicli compute snapshot --app "Calculator" -f json
unicli compute click <ref> --app "Calculator" -f json
```

Available providers depend on the operating system and installed accessibility services. The health response lists the active provider and the setup action for each unavailable provider.

## Native coordinate driver

Cua Driver provides the explicit `--via driver` path for pixel-based desktop actions. Run the provider probe to install a missing driver through its official installer and report macOS Accessibility and Screen Recording permissions.

```bash
unicli doctor compute --providers --install --json
unicli compute screenshot --via driver -f json
```

Inspect the screenshot, choose the target in its pixel coordinates, and pass `.data.observation.ref` to `compute point-click <x> <y> --observation <ref> --via driver`. Each observation expires after 30 seconds and permits one coordinate action. Capture a new screenshot after the visible target changes or the driver restarts.

Uni-CLI forwards capture identity, driver session, and screenshot coordinates. Cua Driver owns Retina scaling and size-capped capture transforms. Live macOS checks on 2026-10-10 confirmed driver 0.34.0, permissions, and screenshots. Behavioral scenarios separately cover capture-bound coordinates, Retina scaling, and single-use observations. Missing permissions and provider failures return structured recovery information.

## Choose the smallest useful interface

Structured APIs and native CLIs are efficient for data and repeatable actions. Browser semantics are useful for signed-in pages. Desktop accessibility reaches installed applications. Visual actions cover interfaces that expose only pixels. `unicli search` reports the operator selected by each catalog entry.
