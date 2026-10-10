<!-- Generated from docs/guide/authentication.md. Do not edit this copy directly. -->

# Authentication

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/authentication
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/authentication.md
- Section: Use Uni-CLI
- Parent: Use Uni-CLI (/guide/)

Uni-CLI reuses the login from a selected local browser profile when an operation needs cookies. Public requests start anonymously. API keys and header credentials follow the requirements declared by each adapter. Browser operations use the selected browser session.

## Start with the operation

Run the command you need. For a read-only HTTP command that declares cookie authentication, Uni-CLI first uses a usable saved credential or the selected browser profile. If the source returns `auth_required` or `challenge_required`, the runtime refreshes the declared credentials and retries once. CLI, MCP, ACP, and hub calls share this recovery path.

To inspect the credential requirements, run the setup command from the error response.

```bash
unicli auth setup <site>
```

The result lists expected cookie names, the connection strategy, and the location used for explicit persistence. Sign in to the site in the intended browser profile, then retry the original operation.

## Select the browser identity

List the local browser profiles.

```bash
unicli browser profiles --json
```

When several profiles exist, select the identity whose browser already has the required login. Copy its profile ID from the result and set it in the environment used by the agent host.

```bash
export UNICLI_BROWSER_PROFILE_ID="<profile-id>"
```

Selection follows the explicit profile ID, then the profile bound to the current managed invocation, then `UNICLI_BROWSER_PROFILE_ID`. Native Chrome and remote connections keep their own identity and do not imply a local profile. A machine with exactly one discovered profile can use it automatically. Multiple profiles without a selection produce an ambiguity error so that the next step can identify the intended account.

## Persist a login explicitly

Normal credential acquisition keeps browser values in memory. Use `auth import` when a site credential should remain available across later commands without reading the browser again.

```bash
unicli auth import <site> --profile-id <profile-id>
```

The established browser-name form remains available.

```bash
unicli auth import <site> --browser chrome
```

If that browser has several profiles, add `--profile <name>` with the profile directory name. Select one identity mechanism per import. `--profile-id`, `--browser` with `--profile`, and `--cdp` are separate choices.

Check the saved file after importing.

```bash
unicli auth check <site>
```

`auth check` checks that the saved cookie file contains usable values and the required keys. Run the original source command to confirm that the remote service accepts the credential.

List sites with saved credentials.

```bash
unicli auth list
```

## Browser operations and Windows cookie import

Browser operations read and act through their own selected session. Start with browser health.

```bash
unicli browser doctor --json
```

For background control of an existing Chrome profile, use the background mode.

```bash
unicli browser --background start
```

For visible foreground control, select focus explicitly.

```bash
unicli browser --focus start
```

On Windows, Chrome v20 cookies require the browser API. Install and connect the browser extension and native host following doctor’s instructions, then use the explicit connection-based import.

```bash
unicli auth import <site> --cdp
```

A standalone Windows `auth import --cdp` selects the background Chrome/native connection. On macOS, a standalone call uses the managed hidden browser; use `--profile-id` for an ordinary signed-in local profile. Starting a browser in one CLI process does not bind a later `auth import` process to that session. Automatic local-profile acquisition retains its selected identity.

Browser commands can also require an expected domain and path, keeping each action attached to its intended page.

## Control automatic recovery

Read-only HTTP commands with declared cookie authentication refresh once after a confirmed authentication failure. Use `--no-auth-retry` to disable automatic credential recovery for a call. Network and HTTP-status retries retain their own policy.

```bash
unicli --no-auth-retry <site> <command> -f json
```

HTTP writes require an explicit `--auth-retry` opt-in for a single credential refresh and retry after a confirmed authentication failure. If a command reports `operation_outcome_ambiguous`, inspect the resource before deciding whether to repeat the write.

Browser-backed commands retain their own turn lifecycle. A browser authentication failure returns directly; complete the required login and start a new operation. Shared HTTP credential retry does not replay a finished browser turn.

For general URLs, `extract` and `web read` make an anonymous request first. Only a 401, 403, or verification challenge starts credential acquisition for the requested domain. The reader can then try saved cookies and fresh browser cookies, through at most three authentication stages. `--no-auth-retry` disables automatic cookie acquisition and recovery. Explicit third-party readers receive the URL without forwarding the source site's cookies.

## Storage and lifetime

Explicit imports are saved per site under `~/.unicli/cookies/`. Files contain plaintext JSON. On macOS and Linux, Uni-CLI uses directory mode `0700` and file mode `0600`; Windows access follows the path's ACL. Keep these files out of source control and use `auth import` to replace an outdated saved login.

Automatically acquired browser cookies remain in memory for the invocation. A refreshed invocation does not rewrite the saved site file. Diagnostic output identifies the selected credential source without printing its values.

## Diagnose a login problem

```bash
unicli auth check <site>
unicli doctor cookies
unicli browser doctor --json
```

Read the credential error first, then follow `checks[].next_step` from browser doctor. It reflects installed browsers, available profiles, broker state, and managed policies. An empty profile needs a login in that profile. An ambiguous selection needs a profile ID. A verification page needs the source's declared browser or API flow before the original operation can succeed.
