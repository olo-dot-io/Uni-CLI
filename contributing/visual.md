# Visual Backend Integration

Visual fallback is Uni-CLI's pixel-level desktop control layer for cases where
API, CDP, and native accessibility cannot expose enough structure. It is a
vendor-neutral contract: the public surface says `visual`, while concrete
backend wiring stays behind local configuration.

## Selection

The built-in default is `mock`, which is deterministic and offline for tests.
Production deployments opt into a remote backend with generic environment
variables:

```bash
export VISUAL_BACKEND=remote
export VISUAL_BACKEND_ENDPOINT=http://localhost:8800
export VISUAL_BACKEND_API_KEY=...
```

The selector lives in `src/transport/adapters/visual.ts`. It returns the same
backend for the same environment snapshot and does not inspect hidden process
state.

## Backend contract

```typescript
interface VisualBackend {
  name: "mock" | "remote";
  snapshot(): Promise<{ base64: string; width: number; height: number }>;
  click(x: number, y: number, button?: "left" | "right"): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
  wait(ms: number): Promise<void>;
  ask?(question: string): Promise<string>;
  launch?(app: string): Promise<void>;
}
```

Keep the backend thin. Complex reasoning belongs in the agent; the backend
only exposes perception and primitive actions.

## Adding a backend

1. Implement `VisualBackend` without changing public step names.
2. Add deterministic unit tests against the transport envelope path.
3. Add one smoke test that proves `snapshot()` and one primitive action work
   against a controlled local target.
4. Document required env vars without vendor-specific names in public docs.
5. Ensure errors preserve `retryable` and `minimum_capability`.

## Security

- Do not log screenshots, OCR, or model observations at default log level.
- Use adapter `domain:` and command-level allow lists for web targets.
- Keep remote backend credentials in environment variables, never adapter YAML.
- Prefer API, CDP, native accessibility, and app APIs before visual fallback.
