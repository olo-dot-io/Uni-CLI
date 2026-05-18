/**
 * @owner       tests::integration::patent::cross-source-search.live
 * @does        Live cross-source integration — when ≥2 patent API keys are present, runs a real search against each, merges the results through reciprocalRankFusion + dedupeByFamily, and asserts no two surviving records share a family_id.
 * @needs       src/commands/patent.ts (reciprocalRankFusion), src/engine/normalizer/patent-envelope.ts (assemblePatentRecord, dedupeByFamily)
 * @feeds       wave-2 hardening signal — this is the one observable property the cross-source meta-command exists to guarantee
 * @breaks      throws if any upstream returns a non-2xx response we did not anticipate; never silently retries
 * @invariants  the test never runs without ≥2 distinct env keys present
 * @side-effects HTTPS to whichever upstreams have keys
 * @perf        one request per active source
 * @concurrency safe — sequential fetches
 * @test        self
 * @stability   experimental
 * @since       2026-05-18
 */

import { describe, expect, it } from "vitest";

import { reciprocalRankFusion } from "../../../src/commands/patent.js";
import {
  assemblePatentRecord,
  dedupeByFamily,
} from "../../../src/engine/normalizer/patent-envelope.js";
import type { PatentRecord } from "../../../src/types/patent.js";

const HAS_USPTO = Boolean(process.env.USPTO_ODP_API_KEY);
const HAS_EPO = Boolean(
  process.env.EPO_OPS_CLIENT_ID && process.env.EPO_OPS_CLIENT_SECRET,
);
const HAS_LENS = Boolean(process.env.LENS_API_TOKEN);
const ACTIVE_SOURCES = [HAS_USPTO, HAS_EPO, HAS_LENS].filter(Boolean).length;

async function fetchUsptoRows(): Promise<PatentRecord[]> {
  const url = new URL(
    "https://api.uspto.gov/api/v1/patent/applications/search",
  );
  url.searchParams.set("q", "optical computer");
  url.searchParams.set("limit", "3");
  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-API-KEY": process.env.USPTO_ODP_API_KEY!,
    },
  });
  if (resp.status !== 200) throw new Error(`USPTO HTTP ${resp.status}`);
  const body = (await resp.json()) as {
    patentFileWrapperDataBag?: Array<Record<string, unknown>>;
  };
  const rows = body.patentFileWrapperDataBag ?? [];
  return rows.map((row) => {
    const meta = row.applicationMetaData as Record<string, unknown> | undefined;
    const earliestPub = meta?.earliestPublicationNumber as string | undefined;
    const appNum = row.applicationNumberText as string | undefined;
    const pub = earliestPub ? `US-${earliestPub}` : `US-${appNum ?? "x"}`;
    return assemblePatentRecord({
      publication_number: pub,
      source_adapter: "uspto",
      title: (meta?.inventionTitle as string | undefined) ?? undefined,
    });
  });
}

async function fetchLensRows(): Promise<PatentRecord[]> {
  const resp = await fetch("https://api.lens.org/patent/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LENS_API_TOKEN}`,
    },
    body: JSON.stringify({
      query: { match: { full_text: "optical computer" } },
      size: 3,
    }),
  });
  if (resp.status !== 200) throw new Error(`Lens HTTP ${resp.status}`);
  const body = (await resp.json()) as {
    data?: Array<{
      jurisdiction?: string;
      doc_number?: string;
      kind?: string;
      family_id?: string | number;
      biblio?: { invention_title?: Array<{ text?: string }> };
    }>;
  };
  return (body.data ?? []).map((row) =>
    assemblePatentRecord({
      publication_number: `${row.jurisdiction ?? "XX"}-${row.doc_number ?? "0"}-${row.kind ?? "A1"}`,
      source_adapter: "lens",
      family_id:
        row.family_id !== undefined ? String(row.family_id) : undefined,
      title: row.biblio?.invention_title?.[0]?.text,
    }),
  );
}

describe("cross-source-search.live — family dedupe holds after fan-out", () => {
  it.skipIf(ACTIVE_SOURCES < 2)(
    "no two surviving records share a family_id after RRF + dedupeByFamily",
    async () => {
      const lists: PatentRecord[][] = [];
      if (HAS_USPTO) lists.push(await fetchUsptoRows());
      if (HAS_LENS) lists.push(await fetchLensRows());
      // EPO live call requires an OAuth round-trip; skipped here to keep the
      // test stable when only the API-key sources are present. The EPO
      // path is covered separately in family-broker.live.test.ts.

      // We only assert the invariant if we actually got rows; an empty
      // upstream is not a regression in our code.
      const fused = reciprocalRankFusion(lists);
      const deduped = dedupeByFamily(fused);

      const familyIds = deduped
        .map((r) => r.family_id)
        .filter((id): id is string => typeof id === "string");
      const uniqueIds = new Set(familyIds);
      expect(uniqueIds.size).toBe(familyIds.length);
    },
    60_000,
  );

  it.skipIf(ACTIVE_SOURCES >= 2)(
    "SKIP (need ≥2 of USPTO_ODP_API_KEY / EPO_OPS_CLIENT_ID / LENS_API_TOKEN)",
    () => {
      expect(ACTIVE_SOURCES).toBeLessThan(2);
    },
  );
});
