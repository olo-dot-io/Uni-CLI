<!-- Generated from docs/guide/authentication.md. Do not edit this copy directly. -->

# Authentication

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/authentication
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/authentication.md
- Section: Use Uni-CLI
- Parent: Use Uni-CLI (/guide/)

Each operation declares how it connects to its target. Public operations run immediately. Cookie and header operations read site credentials. Browser operations use a managed or existing browser session.

## Start with the error envelope

Run the operation once. When login is required, Uni-CLI returns `auth_required` with the matching setup command.

```bash
unicli auth setup <site>
```

This shows the fields expected by the adapter and where Uni-CLI will read them.

## Import a browser login

List local browser profiles:

```bash
unicli browser profiles --json
```

Import credentials from a selected browser:

```bash
unicli auth import <site> --browser chrome
```

Then validate the saved site credentials:

```bash
unicli auth check <site>
```

`auth list` shows the sites configured for the current user.

```bash
unicli auth list
```

## Use a live browser session

Some operations work through a signed-in tab. Start by reading browser health:

```bash
unicli browser doctor --json
```

For background control of an existing Chrome profile:

```bash
unicli browser --background start
```

For visible foreground control:

```bash
unicli browser --focus start
```

A browser command can also require the expected domain and path, which keeps the action attached to the intended page.

## Where credentials live

Explicit imports are stored per site under `~/.unicli/cookies/`. Live browser values stay with the active browser session. Uni-CLI reports the selected source in its diagnostic output.

## Diagnose a login problem

```bash
unicli auth check <site>
unicli doctor cookies
unicli browser doctor --json
```

Use the `checks[].next_step` field from browser doctor as the next command. It reflects the installed browser, available profiles, broker state, and managed policies on the current machine.
