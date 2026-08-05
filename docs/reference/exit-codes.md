---
title: Exit codes
description: Map Uni-CLI process status to the next action in scripts and agents.
---

# Exit codes

Uni-CLI pairs a process exit code with a structured error envelope on stderr. Read `error.code` and `error.suggestion` for the specific cause and next command.

| Code | Name                    | Meaning                                              | Typical next step                           |
| ---: | ----------------------- | ---------------------------------------------------- | ------------------------------------------- |
|    0 | success                 | The operation completed                              | Read `data`                                 |
|    1 | generic error           | An unexpected runtime error occurred                 | Read the envelope and logs                  |
|    2 | usage error             | A command or argument is invalid                     | Run `unicli describe` or `unicli help`      |
|   66 | empty result            | The request completed with no matching item          | Adjust the query or identifier              |
|   69 | service unavailable     | A required service, provider, or tool is unavailable | Follow `error.suggestion`                   |
|   75 | temporary failure       | A timeout, rate limit, or network error occurred     | Retry after the suggested delay             |
|   77 | authentication required | Login or permission is required                      | Run the supplied auth or permission command |
|   78 | configuration error     | An adapter or local configuration needs attention    | Inspect the named source or config file     |

## Shell example

```bash
if output=$(unicli hackernews top --limit 5 -f json); then
  printf '%s\n' "$output" | jq '.data'
else
  status=$?
  printf 'Uni-CLI exited with %s\n' "$status" >&2
fi
```

## Agent example

```text
Run the command with -f json.
If it exits 0, use data.
If it exits 75, wait and retry.
For other failures, read error.code, error.suggestion, and error.remedy.command.
```

The canonical constants live in `src/core/envelope.ts`.
