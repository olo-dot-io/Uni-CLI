# Privacy

Uni-CLI has no hosted telemetry, analytics, usage-tracking, or crash-reporting
service. It is a local execution tool, but executing commands necessarily moves
data across the boundaries selected by the command.

## Network activity

- Website/API adapters send requests to the URLs declared by their adapter and
  to redirects or follow-up endpoints used by that pipeline.
- Browser, desktop, MCP, ACP, plugin, visual, and agent-backend commands may
  communicate with the local or remote service named in their configuration.
- Non-metadata interactive CLI paths may launch a detached,
  three-second-bounded npm registry check. A successful response is cached for
  24 hours. Root `--version` and `--help` do not load it, and the foreground
  process never awaits its network request. Set `NO_UPDATE_NOTIFIER=1` or
  `UNICLI_DISABLE_UPDATE_CHECK=1` to disable it. The request contains no Uni-CLI
  account or usage identifier.
- Uni-CLI does not send command history or adapter results to a Uni-CLI-operated
  service.

## Browser sessions and cookies

Authenticated commands can obtain cookies from three local sources:

1. an explicitly persisted file at `~/.unicli/cookies/<site>.json`;
2. a supported local Chromium profile database; or
3. a live Chrome DevTools Protocol session.

Cookie values are extracted into the Uni-CLI process memory when required. They
may be placed in a `Cookie` request header and sent to the target site declared
by the adapter. Runtime browser/CDP acquisition and automatic auth refresh do
**not** persist those values.

Persistence is an explicit action:

```bash
unicli auth import <site>
unicli browser cookies <domain> [--save-as <site>]
```

Those commands store an unencrypted JSON object on the local filesystem. On
POSIX systems Uni-CLI creates the cookie directory with mode `0700`, the file
with mode `0600`, writes through an owner-only temporary file, and atomically
replaces the destination. Reading an older broad-permission file first tightens
the directory and file to those modes. Windows access is governed by the
selected path's filesystem ACL; POSIX mode numbers do not apply, and Uni-CLI
does not currently create a Windows Credential Manager entry.

Uni-CLI output reports cookie names and counts where useful, never cookie
values. Cookie files are classified as sensitive paths and must not be added to
logs, prompts, commits, or issue reports.

Delete explicit local persistence by removing the relevant file under
`~/.unicli/cookies/`. The next authenticated command can still read the active
local browser session into memory.

## Other local data

Depending on the command, Uni-CLI can create browser automation profiles, run
receipts, downloads, screenshots, adapter overlays, approvals, or caches under
`~/.unicli/` or a user-selected output path. Each command's dry run, help, or
documentation describes its output boundary.

Completed CLI invocations and adapter tool calls write bounded diagnostic
events to UTC-day JSONL files under `~/.unicli/logs/events/`. These events use
an allowlist of scalar operational metadata: Uni-CLI version, base source
revision, clean/dirty/package state and a content digest for dirty checkouts
when available, command identity, transport, target surface, timing,
exit/outcome, result size, and typed error/provider fields. They do not record
command arguments, URLs, queries, content, cookies, credentials, raw output, or
raw error messages or adapter filesystem paths. Newly created directories use
mode `0700`, while a user-selected existing `UNICLI_LOG_ROOT` keeps its mode;
event and lock files use mode `0600` on POSIX systems. Each UTC day is capped
at 16 MiB and the retained store at 128 MiB; a full store reports a local-log
error instead of growing or deleting in-window evidence. The default retention
window is 30 days; set
`UNICLI_LOG_RETENTION_DAYS` to an integer from 1 to 3650 to change it, or
`UNICLI_LOG_ROOT` to move the directory. Set `UNICLI_NO_LOG=1` to disable new
events. The legacy `UNICLI_NO_LEDGER=1` switch remains an equivalent opt-out.
`unicli usage report` reads these events together with the older
`~/.unicli/usage.jsonl`; it reports corrupt rows instead of silently ignoring
them.

Events are terminal observations. `SIGKILL`, power loss, or host failure before
completion cannot produce an event. A hard kill during the bounded store
critical section can leave `.write.lock`; the next writer verifies its recorded
PID is no longer alive and reclaims that exact lock before appending. Live or
unverifiable owners are never stolen and still produce a typed lock timeout.

Delete default diagnostic history by removing `~/.unicli/logs/events/` and the
legacy `~/.unicli/usage.jsonl`. Opt-in run traces under `~/.unicli/runs/` are a
different artifact: they can contain replay arguments and remain disabled
unless `--record` or `UNICLI_RECORD_RUN=1` is set.

## Plugins and configured providers

Third-party plugins, adapters, MCP servers, visual backends, and model providers
run under their own data practices. Review their source and endpoint settings
before sending confidential data. Uni-CLI does not add a second telemetry
channel, but it cannot override the behavior of software the user installs or
configures.

## Questions

For privacy questions, open an issue without secrets or contact
ziming.wang@connect.ust.hk.
