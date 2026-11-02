---
"@zenalexa/unicli": patch
---

- A client that finds the broker shutting down waits for it to exit and starts a new one. Two clients that start together right after an upgrade no longer fail with `browser_broker_shutting_down` while the first retires the old broker.
- A command that fails before its first pipeline step (step `-1`) no longer prints a `[harden] [local-log]` warning: the local event log records steps from 0 and omits the step otherwise.
