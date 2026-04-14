# CUA Backend Integration

CUA (Computer Use API) is the emerging agent standard for giving an agent
pixel-level, cross-application control over a real desktop. Uni-CLI
integrates multiple CUA backends behind a single interface so an adapter
author can request "browser I/O" without knowing which vendor provides it.

Supported backends (Phase 2+):

| Backend         | Vendor        | Transport       | Auth            |
| --------------- | ------------- | --------------- | --------------- |
| `anthropic-cua` | Anthropic     | HTTPS JSON      | API key         |
| `trycua`        | trycua.com    | WebSocket       | API key         |
| `opencua`       | OpenCUA proj. | MCP tools/call  | OIDC / none     |
| `scrapybara`    | Scrapybara    | REST + WSS      | API key         |
| `local-cdp`     | Uni-CLI       | Chrome DevTools | Local (default) |

`local-cdp` is the default — no network dependency, uses the user's own
Chrome. Remote backends are opt-in for agents running on infra without a
local browser.

## Selection

Users pick a backend via env or CLI flag:

```bash
unicli operate --cua anthropic-cua
# or
export UNICLI_CUA=trycua
```

The selector lives in `src/runtime/cua.ts` (Phase 2) and resolves to one
of the backends below. Default fallback: `local-cdp`.

## Backend contract

```typescript
interface CUABackend {
  name: string;
  screenshot(): Promise<Buffer>;
  click(
    x: number,
    y: number,
    button?: "left" | "right" | "middle",
  ): Promise<void>;
  type(text: string): Promise<void>;
  keyPress(key: string, modifiers?: string[]): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  hover(x: number, y: number): Promise<void>;
  drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Promise<void>;

  // Optional — only if the backend supports it:
  readBackground?(): Promise<string>; // text layer / OCR
  activeWindow?(): Promise<{ title: string; rect: Rect }>;
}
```

Keep the backend thin. Complex reasoning ("click the login button")
belongs in the agent, not the backend — the backend only exposes
primitives.

## Adding a new backend

1. Create `src/runtime/cua-<name>.ts` exporting a `CUABackend`.
2. Register in `src/runtime/cua.ts` selector switch.
3. Document auth setup (env vars, API keys, OIDC flow) in a sidecar doc
   under `docs/cua/<name>.md`.
4. Add a smoke test that asserts the backend can at least take a
   screenshot against a known page (e.g. `about:blank`).
5. Add yourself to `CODEOWNERS` for `src/runtime/cua-<name>.ts`.

## Error-translation quirks

Remote backends often return non-standard error shapes:

- **Anthropic**: `{ type: "error", error: { type, message } }` → map to
  `PipelineError({ errorType: "http_error", suggestion: … })`.
- **TryCUA**: WebSocket close frame with reason code → retry on 1011
  (temp), fail on 4401 (auth).
- **Scrapybara**: `202 Accepted` + polling endpoint → wrap with retry,
  return once status is `done`.

The translation layer must set `retryable: true` for transient failures
so the outer `retry` pipeline step can engage.

## Security considerations

- **No secrets in logs**: CUA requests carry user-visible screens that may
  contain passwords, 2FA codes, health data. Never log screenshots or
  OCR output at verbose level unless `UNICLI_CUA_DEBUG_CAPTURE=1`.
- **Allow-list URLs**: Adapters using CUA should specify a `domain:` so
  the operator can gate which sites get screenshot access.
- **Rate limits**: Remote backends bill per action. Default timeout 60s;
  `rate_limit` pipeline step strongly recommended.

See `contributing/transport.md` for the general transport contract — CUA
is a specialized transport with pixel-level verbs.

## Checklist

- [ ] Backend implements the full `CUABackend` interface.
- [ ] Smoke test passes against `about:blank`.
- [ ] Auth setup documented under `docs/cua/<name>.md`.
- [ ] Error translation preserves `retryable` flag.
- [ ] No screenshot/OCR output at default log level.
- [ ] Changeset added.
