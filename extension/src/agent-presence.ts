/**
 * @owner       extension/src/agent-presence.ts
 * @does        Render and remove one foreground target's isolated edge glow and virtual cursor through an on-demand Chrome isolated-world script.
 * @needs       chrome.scripting, cancellable-operation.ts, src/browser/runtime-protocol.ts
 * @feeds       extension/src/chrome-controller.ts
 * @breaks      AgentPresenceError on unavailable scripting, inactive presence, out-of-viewport coordinates, cancellation ambiguity, or malformed renderer results.
 * @invariants  Presence is foreground-only at the controller boundary; the page host is Shadow DOM isolated, pointer-through, semantically hidden from page snapshots/search/accessibility, reduced-motion aware, and has no timer, animation loop, or page-global CSS.
 * @side-effects Adds, updates, or removes one fixed DOM host in the explicitly controlled page.
 * @perf        O(1) DOM nodes and one isolated-world script per explicit update; idle cost is zero scheduled work.
 * @concurrency Broker target ordering serializes updates; request cancellation never replays a dispatched DOM mutation.
 * @test        tests/unit/extension/agent-presence.test.ts, tests/integration/browser-agent-presence.test.ts
 * @stability   experimental
 * @since       2026-07-16
 */

import {
  isBrowserAgentPresenceResult,
  type BrowserAgentPresenceResult,
  type BrowserPageCommand,
} from "../../src/browser/runtime-protocol.js";
import { raceWithCancellation } from "./cancellable-operation.js";

type AgentPresenceCommand = Extract<
  BrowserPageCommand,
  { method: "agent_presence" | "agent_cursor" }
>;

export type AgentPresenceUpdate =
  | { kind: "show"; label: string }
  | { kind: "hide" }
  | { kind: "move"; x: number; y: number; cursor_visible: boolean };

export type AgentPresenceRenderResult = BrowserAgentPresenceResult;

export class AgentPresenceError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: string,
    message: string,
    readonly suggestion: string,
    readonly outcomeAmbiguous = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentPresenceError";
  }
}

export async function executeAgentPresenceCommand(
  tabId: number,
  command: AgentPresenceCommand,
  signal?: AbortSignal,
): Promise<AgentPresenceRenderResult> {
  const update: AgentPresenceUpdate =
    command.method === "agent_presence"
      ? command.visible
        ? {
            kind: "show",
            label: command.label?.trim() || "Uni-CLI agent active",
          }
        : { kind: "hide" }
      : {
          kind: "move",
          x: command.x,
          y: command.y,
          cursor_visible: command.visible !== false,
        };
  return dispatchPresenceUpdate(tabId, update, signal);
}

export function removeAgentPresence(
  tabId: number,
  signal?: AbortSignal,
): Promise<AgentPresenceRenderResult> {
  return dispatchPresenceUpdate(tabId, { kind: "hide" }, signal);
}

async function dispatchPresenceUpdate(
  tabId: number,
  update: AgentPresenceUpdate,
  signal?: AbortSignal,
): Promise<AgentPresenceRenderResult> {
  if (!chrome.scripting?.executeScript) {
    throw new AgentPresenceError(
      "chrome_agent_presence_unavailable",
      "chrome.scripting.executeScript is unavailable",
      "Reload the Uni-CLI extension with scripting and host permissions enabled.",
    );
  }
  let injection: chrome.scripting.InjectionResult<unknown>[];
  try {
    injection = await raceWithCancellation(
      () =>
        chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: renderAgentPresence,
          args: [update],
        }),
      signal,
    );
  } catch (error) {
    throw new AgentPresenceError(
      "chrome_agent_presence_failed",
      `Chrome could not update agent presence: ${errorMessage(error)}`,
      "Confirm the target is a normal foreground web page and retry from a fresh snapshot.",
      signal?.aborted === true,
      { cause: error },
    );
  }
  signal?.throwIfAborted();
  const result = readRenderResult(injection[0]?.result);
  if (result.status === "inactive") {
    throw new AgentPresenceError(
      "chrome_agent_presence_inactive",
      "The virtual cursor cannot move before agent presence is shown",
      "Run the foreground agent-presence show command before moving the virtual cursor.",
    );
  }
  if (result.status === "out_of_bounds") {
    throw new AgentPresenceError(
      "chrome_agent_cursor_out_of_bounds",
      `Virtual cursor coordinates are outside the ${String(result.viewport_width)}x${String(result.viewport_height)} CSS-pixel viewport`,
      "Use coordinates from the current foreground page snapshot without clamping or scale inference.",
    );
  }
  return result;
}

function readRenderResult(value: unknown): AgentPresenceRenderResult {
  if (!isBrowserAgentPresenceResult(value)) {
    throw new AgentPresenceError(
      "chrome_agent_presence_invalid",
      "Chrome agent-presence renderer returned an invalid result",
      "Reload the Uni-CLI extension and retry on a freshly claimed foreground tab.",
      true,
    );
  }
  return value as AgentPresenceRenderResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderAgentPresence(
  update: AgentPresenceUpdate,
): AgentPresenceRenderResult {
  const selector =
    'unicli-agent-presence[data-unicli-owner="decklegbfaimflikbihddclmbiiaiakg"]';
  let host = document.querySelector(selector) as HTMLElement | null;
  const viewport = {
    viewport_width: Math.max(0, window.innerWidth),
    viewport_height: Math.max(0, window.innerHeight),
  };
  if (update.kind === "hide") {
    host?.remove();
    return {
      status: "hidden",
      cursor_visible: false,
      ...viewport,
    };
  }
  if (update.kind === "move" && !host?.shadowRoot) {
    return {
      status: "inactive",
      cursor_visible: false,
      ...viewport,
    };
  }
  if (update.kind === "move") {
    const cursor =
      host!.shadowRoot!.querySelector<HTMLElement>("[part=cursor]");
    if (!cursor) {
      return {
        status: "inactive",
        cursor_visible: false,
        ...viewport,
      };
    }
    if (
      update.x >= viewport.viewport_width ||
      update.y >= viewport.viewport_height
    ) {
      return {
        status: "out_of_bounds",
        cursor_visible: cursor.style.opacity === "1",
        ...viewport,
        x: update.x,
        y: update.y,
      };
    }
    cursor.style.transform = `translate3d(${String(update.x)}px, ${String(update.y)}px, 0)`;
    cursor.style.opacity = update.cursor_visible ? "1" : "0";
    return {
      status: "visible",
      cursor_visible: update.cursor_visible,
      ...viewport,
      x: update.x,
      y: update.y,
    };
  }
  if (!host?.shadowRoot) {
    host?.remove();
    host = document.createElement("unicli-agent-presence");
    host.setAttribute("data-unicli-owner", "decklegbfaimflikbihddclmbiiaiakg");
    host.setAttribute("aria-hidden", "true");
    for (const [property, value] of [
      ["all", "initial"],
      ["display", "block"],
      ["position", "fixed"],
      ["inset", "0"],
      ["width", "100vw"],
      ["height", "100vh"],
      ["pointer-events", "none"],
      ["z-index", "2147483647"],
      ["contain", "layout style paint"],
    ]) {
      host.style.setProperty(property, value, "important");
    }
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host, *, *::before, *::after { box-sizing: border-box; pointer-events: none !important; }
      [part="frame"] {
        position: absolute;
        inset: 0;
        border: 1px solid rgba(193, 154, 82, 0.88);
        box-shadow: inset 0 0 7px rgba(193, 154, 82, 0.46), inset 0 0 30px rgba(193, 154, 82, 0.20);
      }
      [part="badge"] {
        position: absolute;
        top: 12px;
        left: 50%;
        transform: translateX(-50%);
        max-width: min(70vw, 520px);
        overflow: hidden;
        padding: 6px 11px;
        border: 1px solid rgba(193, 154, 82, 0.72);
        border-radius: 999px;
        background: rgba(23, 19, 15, 0.92);
        color: #f6f0e3;
        font: 600 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0.01em;
        text-overflow: ellipsis;
        white-space: nowrap;
        box-shadow: 0 4px 16px rgba(23, 19, 15, 0.24);
      }
      [part="badge"]::before {
        content: "";
        display: inline-block;
        width: 6px;
        height: 6px;
        margin: 0 7px 1px 0;
        border-radius: 50%;
        background: #6f8f72;
      }
      [part="cursor"] {
        position: absolute;
        top: -2px;
        left: -2px;
        width: 24px;
        height: 28px;
        opacity: 0;
        transform: translate3d(0, 0, 0);
        transform-origin: 2px 2px;
        transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), opacity 100ms linear;
      }
      [part="cursor"]::before {
        content: "";
        position: absolute;
        inset: 0 4px 6px 0;
        clip-path: polygon(0 0, 0 100%, 29% 73%, 45% 100%, 61% 91%, 45% 64%, 82% 64%);
        background: #f6f0e3;
        box-shadow: inset 0 0 0 1.5px #17130f;
      }
      [part="cursor"]::after {
        content: "";
        position: absolute;
        top: -5px;
        left: -5px;
        width: 12px;
        height: 12px;
        border: 1px solid rgba(193, 154, 82, 0.92);
        border-radius: 50%;
        box-shadow: 0 0 10px rgba(193, 154, 82, 0.62);
      }
      @media (prefers-reduced-motion: reduce) {
        [part="cursor"] { transition-duration: 0.01ms; }
      }
    </style><div part="frame"></div><div part="badge"></div><div part="cursor"></div>`;
    document.documentElement.append(host);
  }
  const badge = host.shadowRoot!.querySelector<HTMLElement>("[part=badge]");
  const cursor = host.shadowRoot!.querySelector<HTMLElement>("[part=cursor]");
  if (!badge || !cursor) {
    host.remove();
    return {
      status: "inactive",
      cursor_visible: false,
      ...viewport,
    };
  }
  badge.textContent = update.label.slice(0, 80);
  return {
    status: "visible",
    cursor_visible: cursor.style.opacity === "1",
    ...viewport,
  };
}
