/**
 * Interactive Probing — click elements to trigger API calls.
 *
 * Uses accessibility tree snapshot for smart element selection,
 * with role-aware filtering and dangerous element avoidance.
 */

import type { IPage } from "../types.js";

export interface ProbeOptions {
  maxClicks?: number;
  delayMs?: number;
  labels?: string[];
  roles?: string[];
}

export interface ProbeResult {
  clicked: number;
  labels: string[];
}

const SKIP_PATTERNS =
  /登录|注册|login|sign.?in|sign.?up|close|关闭|下载.?app|download.?app|cookie|privacy|install/i;
const PREFER_PATTERNS =
  /更多|热门|推荐|全部|more|all|popular|trending|hot|load.?more|show.?more|expand/i;

export async function probeInteractive(
  page: IPage,
  opts?: ProbeOptions,
): Promise<ProbeResult> {
  const maxClicks = opts?.maxClicks ?? 12;
  const delayMs = opts?.delayMs ?? 400;
  const preferredRoles = opts?.roles ?? ["tab", "button", "link"];
  const clicked: string[] = [];

  // Step 1: Targeted label clicks
  if (opts?.labels?.length) {
    for (const label of opts.labels) {
      try {
        const safeLabel = JSON.stringify(label);
        await page.evaluate(
          `(() => {
            const el = [...document.querySelectorAll('button, [role="button"], [role="tab"], a, span')]
              .find(e => e.textContent && e.textContent.trim().includes(${safeLabel}));
            if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          })()`,
        );
        clicked.push(label);
        await page.wait(delayMs / 1000);
      } catch {
        /* label not found */
      }
    }
  }

  if (clicked.length >= maxClicks) {
    return { clicked: clicked.length, labels: clicked };
  }

  // Step 2: Snapshot-based probing
  try {
    const snap = await page.snapshot({ interactive: true, compact: true });

    // Parse interactive refs from snapshot text
    // Format: [ref=N] tag "text" or [N] text
    const refPattern = /\[(?:ref=)?(\d+)\]\s*(\w+)?\s*"?([^"\n]*)"?/g;
    const refs: Array<{ ref: string; tag: string; text: string }> = [];
    let match: RegExpExecArray | null;

    while ((match = refPattern.exec(snap)) !== null) {
      refs.push({ ref: match[1], tag: match[2] ?? "", text: match[3] ?? "" });
    }

    // Filter and rank
    const candidates = refs
      .filter((r) => !SKIP_PATTERNS.test(r.text))
      .filter((r) => r.text.trim().length > 0)
      .sort((a, b) => {
        const aPrefer = PREFER_PATTERNS.test(a.text) ? -1 : 0;
        const bPrefer = PREFER_PATTERNS.test(b.text) ? -1 : 0;
        if (aPrefer !== bPrefer) return aPrefer - bPrefer;

        const aRole = preferredRoles.indexOf(a.tag.toLowerCase());
        const bRole = preferredRoles.indexOf(b.tag.toLowerCase());
        const aIdx = aRole >= 0 ? aRole : preferredRoles.length;
        const bIdx = bRole >= 0 ? bRole : preferredRoles.length;
        return aIdx - bIdx;
      });

    // Click top candidates
    const remaining = maxClicks - clicked.length;
    for (const cand of candidates.slice(0, remaining)) {
      // Validate ref is numeric-only to prevent CSS selector injection
      if (!/^\d+$/.test(cand.ref)) continue;
      try {
        await page.evaluate(
          `(() => {
            const el = document.querySelector('[data-unicli-ref="${cand.ref}"]');
            if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          })()`,
        );
        clicked.push(cand.text.slice(0, 30));
        await page.wait(delayMs / 1000);
      } catch {
        /* click failed */
      }
    }
  } catch {
    /* snapshot failed — return what we have */
  }

  return { clicked: clicked.length, labels: clicked };
}
