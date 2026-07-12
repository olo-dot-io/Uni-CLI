# Security Policy

## Supported versions

| Version              | Support                 |
| -------------------- | ----------------------- |
| Latest published 0.x | Security fixes          |
| Older 0.x releases   | Upgrade to latest first |

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, cookies, or
private user data.

1. Use GitHub private vulnerability reporting, or email
   ziming.wang@connect.ust.hk.
2. Include the affected version/commit, reproduction, impact, and the smallest
   non-secret evidence needed to verify it.
3. The maintainer will acknowledge the report and provide a remediation plan
   after triage.

Reporter credit is optional and uses the reporter's preferred public name or
handle. GitHub advisory credit requires the reporter to accept GitHub's credit
invitation.

## Credential and cookie boundaries

- Browser profile databases and CDP sessions can be read into process memory
  for authenticated commands.
- Cookies are sent only through the command's target request/browser boundary;
  values are not emitted in normal output or telemetry.
- Runtime acquisition and automatic auth refresh do not write cookies to disk.
- `unicli auth import` and `unicli browser cookies` are explicit persistence
  commands. They store unencrypted JSON under
  `~/.unicli/cookies/<site>.json`.
- On POSIX systems the cookie directory is `0700`, files are `0600`, writes are
  atomic, symlink reads are rejected, and legacy broad permissions are tightened
  before use. Windows security depends on the selected path's filesystem ACL;
  the current file backend does not claim Credential Manager protection.
- Cookie paths are treated as sensitive by permission and logging policy. Never
  attach their contents to issues, traces, prompts, or commits.

## Browser control

Browser automation may require powerful extension/CDP capabilities, including
access to tabs, cookies, debugging, and declared page origins. Uni-CLI uses
process-verified live profiles or Uni-CLI-owned automation profiles; it does not
claim Chrome's default profile is a supported remote-debugging target on Chrome
136+.

Run `unicli browser doctor --json` before granting or debugging browser access.
The output reports the selected profile source, policy state, and exact repair
command without exposing cookie values.

## Adapter and execution boundaries

- YAML adapters use the registered pipeline primitives and validated template
  expressions; TypeScript adapters and installed plugins execute code and must
  be reviewed as code.
- HTTP fetches pass scheme and reserved/local-address SSRF checks unless the
  user explicitly enables local development access.
- Permission profiles, deny rules, approvals, trust labels, and confidentiality
  labels govern declared command effects. They are not a substitute for OS
  sandboxing of arbitrary third-party code.
- Structured error envelopes preserve the owning adapter path and failure class
  so agents do not need to guess or suppress errors.

## Supply chain

`package.json` and `package-lock.json` are the source of truth for runtime
dependencies. Security claims must follow the checked-in workflows and actual
`npm audit --omit=dev` result; dependency counts or audit gates are not stated
manually here.

The pull-request/mainline matrix runs the full Linux gate on Node 22 and a
build/unit compatibility gate plus `npm audit --omit=dev --audit-level=moderate`
on Node 24. The release workflow repeats the production audit before packing or
publishing. `npm run truth:check` verifies those workflow and documentation
contracts from repository state.
