# Exit Codes

Uni-CLI uses exit codes from `sysexits.h` — the UNIX standard for machine-parseable process exit status. Every exit code tells an AI agent exactly what kind of failure occurred and what to do next.

## Code Reference

| Code | Constant             | Meaning               | Agent Response                    |
| ---- | -------------------- | --------------------- | --------------------------------- |
| 0    | `SUCCESS`            | Command succeeded     | Use the data from stdout          |
| 1    | `GENERIC_ERROR`      | Unclassified error    | Read stderr JSON for details      |
| 2    | `USAGE_ERROR`        | Bad arguments or syntax | Fix the command invocation      |
| 66   | `EMPTY_RESULT`       | No data returned      | Try different parameters or query |
| 69   | `SERVICE_UNAVAILABLE`| Target site is down   | Retry later                       |
| 75   | `TEMP_FAILURE`       | Temporary failure     | Retry with exponential backoff    |
| 77   | `AUTH_REQUIRED`      | Authentication needed | Run `unicli auth setup <site>`    |
| 78   | `CONFIG_ERROR`       | Adapter misconfigured | Read and fix the YAML adapter     |

## Code 0 — Success

The command completed and produced output. Data is on stdout (JSON when piped, table in terminal).

```bash
unicli hackernews top
echo $?    # 0
```

## Code 1 — Generic Error

An error that does not fit other categories. Check stderr for a structured JSON error:

```bash
unicli example broken 2>/tmp/err.json
echo $?    # 1
cat /tmp/err.json
```

```json
{
  "error": "unexpected_response",
  "adapter_path": "/path/to/adapter.yml",
  "step": 0,
  "action": "fetch",
  "message": "Expected JSON, got HTML"
}
```

## Code 2 — Usage Error

The command was invoked incorrectly — missing required arguments, unknown flags, or invalid syntax.

```bash
unicli hackernews
# Error: missing command. Available: top, new, ask, show, jobs, ...
echo $?    # 2
```

Agent action: fix the command syntax. Run `unicli list <site>` to see available commands and arguments.

## Code 66 — Empty Result

The command executed successfully against the API, but the result set is empty. This is not an error — the query simply matched nothing.

```bash
unicli reddit search --subreddit "tinysub" --query "xyzzy"
echo $?    # 66
```

Agent action: try broader search terms, different parameters, or a different time range. The adapter and API are working correctly.

## Code 69 — Service Unavailable

The target service is unreachable. The site may be down, blocked, or experiencing an outage.

```bash
unicli example fetch-data
echo $?    # 69
```

Agent action: retry after a delay. If the failure persists, check if the site is globally down or if the network is restricted.

## Code 75 — Temporary Failure

A transient error — rate limiting, temporary server error, or network glitch. The built-in retry mechanism has already attempted retries and exhausted them.

```bash
unicli twitter timeline
echo $?    # 75
```

Agent action: wait and retry the entire command. Consider adding a `rate_limit` step to the adapter if rate limiting is the recurring cause.

## Code 77 — Auth Required

The command requires authentication, but no valid credentials are available. Either cookies have not been set up, or they have expired.

```bash
unicli bilibili feed
echo $?    # 77
```

Agent action:

```bash
unicli auth setup bilibili    # Interactive: opens Chrome login
unicli auth check bilibili    # Verify cookies are valid
unicli bilibili feed          # Retry
```

## Code 78 — Config Error

The adapter YAML is invalid or misconfigured. This typically means a selector changed, a URL is wrong, or the pipeline has a structural error.

```bash
unicli example broken-adapter
echo $?    # 78
```

Agent action: read the adapter YAML at the path in the stderr error JSON, fix the configuration, and retry. See the [Self-Repair guide](/guide/self-repair) for the full workflow.

## Programmatic Handling

### Shell Script

```bash
unicli bilibili feed --json
case $? in
  0)  echo "Success" ;;
  66) echo "No results" ;;
  77) unicli auth setup bilibili ;;
  75) sleep 10 && unicli bilibili feed --json ;;
  *)  echo "Unexpected error" ;;
esac
```

### AI Agent (pseudocode)

```
result = run("unicli bilibili feed --json")

if result.exit_code == 0:
    return parse_json(result.stdout)

if result.exit_code == 77:
    run("unicli auth setup bilibili")
    return retry()

if result.exit_code == 78:
    error = parse_json(result.stderr)
    adapter = read_file(error.adapter_path)
    fix = apply_suggestion(adapter, error.suggestion)
    write_file(error.adapter_path, fix)
    return retry()

if result.exit_code in [69, 75]:
    wait(exponential_backoff)
    return retry()
```

## Source Definition

Exit codes are defined in `src/types.ts`:

```typescript
export const ExitCode = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,
  EMPTY_RESULT: 66,
  SERVICE_UNAVAILABLE: 69,
  TEMP_FAILURE: 75,
  AUTH_REQUIRED: 77,
  CONFIG_ERROR: 78,
} as const;
```

These values follow the BSD `sysexits.h` convention, ensuring compatibility with UNIX toolchains and CI/CD systems that interpret exit codes programmatically.
