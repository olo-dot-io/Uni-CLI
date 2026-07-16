/**
 * @owner       src/browser/snapshot-identity.ts
 * @does        Verify snapshot refs against identity metadata and the exact live-node registry before any action.
 * @needs       src/browser/ref-target.ts, target-errors.ts, src/types.ts
 * @feeds       browser click/type/query steps and direct computer-use browser tools
 * @breaks      Missing, detached, mismatched, or ambiguous refs throw typed target errors; plain CSS selectors retain their non-ref contract.
 * @invariants  Snapshot-generated refs resolve through the latest renderer node registry; the DOM-query path exists only for legacy fingerprints without that registry.
 * @side-effects Reads renderer snapshot globals; the exported legacy persistence script refreshes registry state for `browser find`.
 * @perf        O(1) for snapshot-generated refs; legacy verification is O(document matches).
 * @concurrency A navigation or newer snapshot makes the previous registry unavailable or stale before mutation.
 * @test        tests/unit/browser/target-errors.test.ts, tests/integration/browser-ref-capabilities.test.ts
 * @stability   experimental
 * @since       2026-04-24
 */

import type { IPage } from "../types.js";
import {
  BrowserRefTargetError,
  buildBrowserRefTargetExpression,
  extractBrowserSnapshotRef,
  readBrowserRefTargetResult,
} from "./ref-target.js";
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
  const nodesByRef = new Map();
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
    } catch { /* detached node */ }
    const entry = { role: role, taken_at: takenAt };
    if (name) entry.name = name;
    if (bbox) entry.bbox = bbox;
    map[ref] = entry;
    nodesByRef.set(ref, el);
  }
  window.__unicli_ref_identity = map;
  window.__unicli_ref_nodes = nodesByRef;
  window.__unicli_ref_snapshot_id = 'find:' + String(takenAt);
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
 * Extract the numeric ref from a `[data-unicli-ref=<N>]` selector.
 * Accepts double-quoted, single-quoted, and unquoted attribute-value
 * forms, so compound selectors like `button[data-unicli-ref="3"].primary`
 * and hand-rolled `[data-unicli-ref=3]` both resolve. Returns null for
 * selectors that don't carry a data-unicli-ref attribute at all (plain
 * CSS selectors bypass verification — backward compat).
 */
export function extractRef(selector: string): string | null {
  return extractBrowserSnapshotRef(selector);
}

/**
 * Canonical single-element selector for a given ref — used by verifyRef's
 * `countMatches` call so the count reflects ref uniqueness and not the
 * caller's compound selector (e.g. `button[data-unicli-ref="3"].primary`
 * may narrow the match count artificially).
 */
function canonicalRefSelector(ref: string): string {
  return `[data-unicli-ref="${ref}"]`;
}

interface IdentityEntry {
  role: string;
  name?: string;
  bbox?: [number, number, number, number];
  taken_at: number;
}

/**
 * Reads the fingerprint entry for a given ref from the live page, or null
 * if no entry exists (stale snapshot) or the global is malformed.
 */
export async function readFingerprint(
  page: IPage,
  ref: string,
): Promise<IdentityEntry | null> {
  const refJson = JSON.stringify(ref);
  const raw = await page.evaluate(
    `(() => { const m = window.__unicli_ref_identity; return m ? (m[${refJson}] || null) : null; })()`,
  );
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const entry = raw as Partial<IdentityEntry>;
  if (typeof entry.role !== "string") return null;
  return entry as IdentityEntry;
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
 * stale_ref / ambiguous / ref_not_found. Plain CSS selectors bypass
 * verification (backward compat for hand-written YAML adapters).
 *
 * NOTE: verifyRef is best-effort, not atomic with the subsequent click/type
 * call. Between the fingerprint read, the match count, and the caller's
 * action, the DOM may re-render. A pass means the ref was valid at verify
 * time; callers doing recovery should retry with a fresh snapshot on any
 * post-click surprise.
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
  const targetExpression = buildBrowserRefTargetExpression(selector);
  if (targetExpression) {
    const target = readBrowserRefTargetResult(
      await page.evaluate(targetExpression),
    );
    if (target.status === "found") return;
    if (target.status !== "registry_unavailable") {
      const candidates = await listCandidates(page);
      if (target.status === "stale") {
        throw staleRef(
          ref,
          (await getSnapshotAge(page)) ?? undefined,
          candidates.length ? candidates : undefined,
        );
      }
      if (
        target.status === "unsupported_frame" ||
        target.status === "not_interactable" ||
        target.status === "occluded"
      ) {
        throw new BrowserRefTargetError(target.status, ref);
      }
      throw notFound(ref, candidates.length ? candidates : undefined);
    }
  }
  // Count via the canonical ref selector so ref uniqueness is verified,
  // not the caller's compound selector (e.g. `button[data-unicli-ref="3"].primary`).
  const count = await countMatches(page, canonicalRefSelector(ref));
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
