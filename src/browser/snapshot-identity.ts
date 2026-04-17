/**
 * Fingerprint persistence for the ref-backed locator verification layer.
 *
 * On every snapshot we persist a map on the page:
 *
 *   window.__unicli_ref_identity   : Record<ref, {role, name?, bbox?, taken_at}>
 *   window.__unicli_ref_taken_at   : number (ms epoch)
 *
 * Click/type steps read this map before acting and throw TargetError if the
 * ref is stale, ambiguous, or not found. See target-errors.ts.
 */

import type { IPage } from "../types.js";
import {
  ambiguous,
  notFound,
  staleRef,
  type TargetCandidate,
} from "./target-errors.js";

/**
 * JS expression — scans all `[data-unicli-ref]` elements currently in the
 * DOM and writes them to `window.__unicli_ref_identity`. Overwrites any
 * prior map (spec: overwrite on each snapshot, not diff).
 *
 * Emits the map as a string via JSON.stringify so Runtime.evaluate returns
 * a serialisable value (no function / bigint / DOM node in the return path).
 */
export const FINGERPRINT_PERSIST_JS = `(() => {
  const takenAt = Date.now();
  const map = {};
  const nodes = document.querySelectorAll('[data-unicli-ref]');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const ref = el.getAttribute('data-unicli-ref');
    if (!ref) continue;
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const name =
      el.getAttribute('aria-label') ||
      el.getAttribute('name') ||
      el.getAttribute('placeholder') ||
      (el.textContent || '').trim().slice(0, 80) ||
      undefined;
    let bbox;
    try {
      const r = el.getBoundingClientRect();
      bbox = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    } catch (e) { /* detached node */ }
    const entry = { role: role, taken_at: takenAt };
    if (name) entry.name = name;
    if (bbox) entry.bbox = bbox;
    map[ref] = entry;
  }
  window.__unicli_ref_identity = map;
  window.__unicli_ref_taken_at = takenAt;
  return takenAt;
})()`;

/**
 * Returns ms since the most recent snapshot, or null if none has been taken
 * (or the page has navigated away and the window globals were wiped).
 */
export async function getSnapshotAge(page: IPage): Promise<number | null> {
  const raw = await page.evaluate(
    `(() => { const t = window.__unicli_ref_taken_at; return typeof t === 'number' ? (Date.now() - t) : null; })()`,
  );
  return typeof raw === "number" ? raw : null;
}

/**
 * Extract the numeric ref from a `[data-unicli-ref="<N>"]` selector.
 * Returns null for selectors that don't match this shape (plain CSS
 * selectors bypass verification — backward compat).
 */
export function extractRef(selector: string): string | null {
  const match = /\[data-unicli-ref="([^"]+)"\]/.exec(selector);
  return match ? match[1] : null;
}

interface IdentityEntry {
  role: string;
  name?: string;
  bbox?: [number, number, number, number];
  taken_at: number;
}

/**
 * Reads the fingerprint entry for a given ref from the live page, or null
 * if no entry exists (stale snapshot).
 */
export async function readFingerprint(
  page: IPage,
  ref: string,
): Promise<IdentityEntry | null> {
  const refJson = JSON.stringify(ref);
  const raw = await page.evaluate(
    `(() => { const m = window.__unicli_ref_identity; return m ? (m[${refJson}] || null) : null; })()`,
  );
  return raw as IdentityEntry | null;
}

/**
 * Counts how many live elements currently match the given CSS selector.
 */
export async function countMatches(
  page: IPage,
  selector: string,
): Promise<number> {
  const selJson = JSON.stringify(selector);
  const raw = await page.evaluate(
    `document.querySelectorAll(${selJson}).length`,
  );
  return typeof raw === "number" ? raw : 0;
}

/**
 * Verify that a `[data-unicli-ref="<N>"]`-style selector binds to exactly
 * one live element in the current fingerprint map. Throws TargetError on
 * stale_ref / ambiguous / not_found. Plain CSS selectors bypass
 * verification (backward compat for hand-written YAML adapters).
 */
export async function verifyRef(page: IPage, selector: string): Promise<void> {
  const ref = extractRef(selector);
  if (ref === null) return;
  const entry = await readFingerprint(page, ref);
  if (!entry) {
    const age = await getSnapshotAge(page);
    const candidates = await listCandidates(page);
    throw staleRef(
      ref,
      age ?? undefined,
      candidates.length ? candidates : undefined,
    );
  }
  const count = await countMatches(page, selector);
  if (count === 0) {
    const candidates = await listCandidates(page);
    throw notFound(ref, candidates.length ? candidates : undefined);
  }
  if (count > 1) {
    const candidates = await listCandidates(page);
    throw ambiguous(ref, candidates);
  }
}

/**
 * Returns the list of candidate refs from the current fingerprint map.
 * Used to populate TargetError.detail.candidates so the caller can recover.
 */
export async function listCandidates(page: IPage): Promise<TargetCandidate[]> {
  const raw = await page.evaluate(
    `(() => {
      const m = window.__unicli_ref_identity;
      if (!m) return [];
      const out = [];
      for (const k of Object.keys(m)) {
        out.push({ ref: k, role: m[k].role, name: m[k].name });
      }
      return out;
    })()`,
  );
  return Array.isArray(raw) ? (raw as TargetCandidate[]) : [];
}
