/**
 * Lifecycle hooks — plugins can register handlers for startup, pre/post execution.
 * Singleton pattern via globalThis ensures hooks survive across npm-linked modules.
 */

export type HookName = "onStartup" | "onBeforeExecute" | "onAfterExecute";

export interface HookContext {
  command: string; // "site/name" or "__startup__"
  args: Record<string, unknown>;
  startedAt?: number;
  finishedAt?: number;
  error?: unknown;
  [key: string]: unknown; // plugins can attach arbitrary data
}

type HookHandler = (ctx: HookContext, result?: unknown) => Promise<void>;

interface HookRegistry {
  handlers: Map<HookName, Set<HookHandler>>;
}

// Singleton — survives across npm-linked module copies
const REGISTRY_KEY = "__unicli_hooks__";

function getRegistry(): HookRegistry {
  if (!(globalThis as Record<string, unknown>)[REGISTRY_KEY]) {
    (globalThis as Record<string, unknown>)[REGISTRY_KEY] = {
      handlers: new Map<HookName, Set<HookHandler>>(),
    };
  }
  return (globalThis as Record<string, unknown>)[REGISTRY_KEY] as HookRegistry;
}

function addHandler(name: HookName, fn: HookHandler): void {
  const registry = getRegistry();
  if (!registry.handlers.has(name)) {
    registry.handlers.set(name, new Set());
  }
  registry.handlers.get(name)!.add(fn); // Set deduplicates by reference
}

/** Register a startup hook — called once at CLI boot. */
export function onStartup(fn: (ctx: HookContext) => Promise<void>): void {
  addHandler("onStartup", fn);
}

/** Register a pre-execution hook — called before every command. */
export function onBeforeExecute(fn: (ctx: HookContext) => Promise<void>): void {
  addHandler("onBeforeExecute", fn);
}

/** Register a post-execution hook — called after every command. */
export function onAfterExecute(
  fn: (ctx: HookContext, result?: unknown) => Promise<void>,
): void {
  addHandler("onAfterExecute", fn);
}

/**
 * Emit a hook — calls all registered handlers sequentially.
 * Each handler is wrapped in try/catch so a failing hook never blocks execution.
 */
export async function emitHook(
  name: HookName,
  ctx: HookContext,
  result?: unknown,
): Promise<void> {
  const registry = getRegistry();
  const handlers = registry.handlers.get(name);
  if (!handlers) return;

  for (const handler of handlers) {
    try {
      await handler(ctx, result);
    } catch (err) {
      // Hook failure should NEVER block command execution
      console.error(
        `[hook] ${name} handler failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
