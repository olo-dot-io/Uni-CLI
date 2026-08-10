<!-- Generated from docs/guide/upgrading.md. Do not edit this copy directly. -->

# Keep Uni-CLI Current

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/upgrading
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/upgrading.md
- Section: Start
- Parent: Start (/)

Uni-CLI reads cached npm release metadata during normal commands. A detached refresh runs at most once every 24 hours, so ordinary work never waits for the registry.

## Default update policy

A persistent global installation used by a non-interactive Agent schedules the exact cached release automatically. The install runs in a detached worker and takes effect on the next Uni-CLI process.

Interactive terminals keep the visible Y/N choice. Source checkouts, CI, `npx`, `pnpx`, and `bunx` never auto-install.

Use a persistent preference when a machine needs a different policy.

```bash
unicli upgrade --auto-update
unicli upgrade --no-auto-update
```

`UNICLI_AUTO_UPDATE=0` disables automatic updates for the current environment. `UNICLI_AUTO_UPDATE=1` enables them for persistent interactive installations too. Environment settings override the stored preference.

## Check the installed release

```bash
unicli upgrade --check -f json
```

The result includes `current`, `latest`, `update_available`, the detected package manager, and any active reminder choice.

## Choose Y or N

```bash
unicli upgrade
```

Press `Y` or Enter to install the exact offered release. Press `N` to continue and receive another reminder after 24 hours.

The following command hides only the current offered release. A later release appears normally.

```bash
unicli upgrade --skip-version
```

## Agent update metadata

JSON, YAML, and Markdown envelopes carry `meta.update` when the installed release is old. `automatic_update.status` reports whether the detached install was scheduled, is already running, succeeded, is waiting to retry, or needs an explicit choice.

MCP servers publish the same notice under `_meta["io.unicli/update"]`, including servers started through `unicli-mcp`.

```json
{
  "meta": {
    "update": {
      "status": "available",
      "current": "1.1.0",
      "latest": "1.1.1",
      "unattended_command": "unicli upgrade --yes",
      "decline_command": "unicli upgrade --no",
      "automatic_update": {
        "enabled": true,
        "status": "scheduled",
        "package_manager": "npm",
        "opt_out": "UNICLI_AUTO_UPDATE=0"
      }
    }
  }
}
```

An Agent can still request an immediate foreground update and verify the result.

```bash
unicli upgrade --yes -f json
unicli --version
```

When automatic updates are disabled, a non-interactive call without `--yes` returns `confirmation_required` with commands for approval, deferral, and skipping the current release.

## Package managers and recovery

Uni-CLI detects persistent global npm, pnpm, and Bun installations. Every automatic and explicit install pins the exact validated version and starts the package manager without a shell.

A lease prevents concurrent Agent processes from starting duplicate global installs. Failures are recorded in owner-only local state and retried after a bounded delay.

Source checkouts and ephemeral runners require an explicit package manager or a fresh global install.

```bash
unicli upgrade --yes --package-manager npm
npm install --global @zenalexa/unicli@latest
```

CI disables background checks and automatic installation. The following controls disable release checks entirely.

```bash
NO_UPDATE_NOTIFIER=1
UNICLI_DISABLE_UPDATE_CHECK=1
```

`UNICLI_UPDATE_CHECK_FORCE=1` enables a diagnostic check in CI. It never approves installation.
