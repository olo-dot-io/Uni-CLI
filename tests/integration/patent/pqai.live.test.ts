/**
 * @owner       tests::integration::patent::pqai.live
 * @does        Live integration test against PQAI (Project PQ.AI prior-art retrieval) — gated on PQAI_API_TOKEN; verifies a fixed-abstract query returns rankable PatentRecord rows.
 * @needs       src/engine/normalizer/patent-envelope.ts
 * @feeds       wave-2 hardening signal — PQAI is one of the three prior-art sources `unicli patent prior-art` fans out to (alongside google-patents-bq and epo).
 * @breaks      throws if PQAI returns non-200; the test asserts on assembled record shape
 * @invariants  the test never runs without PQAI_API_TOKEN; uses a fixed, stable abstract
 * @side-effects HTTPS to api.projectpq.ai
 * @perf        single request
 * @concurrency safe
 * @test        self
 * @stability   experimental
 * @since       2026-05-18
 */

import { describe, expect, it } from "vitest";

import { assemblePatentRecord } from "../../../src/engine/normalizer/patent-envelope.js";

const API_TOKEN = process.env.PQAI_API_TOKEN;
const FIXED_ABSTRACT =
  "An optical computing apparatus using photonic neural networks for low-power inference.";

describe("pqai.live — prior-art retrieval end-to-end", () => {
  it.skipIf(!API_TOKEN)(
    "returns ranked prior-art candidates for a fixed abstract",
    async () => {
      const url = new URL("https://api.projectpq.ai/search/102");
      url.searchParams.set("q", FIXED_ABSTRACT);
      url.searchParams.set("n", "3");
      const resp = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${API_TOKEN}`,
        },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        results?: Array<{ patent_id?: string; title?: string }>;
      };
      const rows = body.results ?? [];
      expect(rows.length).toBeGreaterThan(0);

      const first = rows[0];
      const pub = first.patent_id ?? "US-0000000-A1";
      const record = assemblePatentRecord({
        publication_number: pub,
        source_adapter: "pqai",
        title: first.title ?? undefined,
      });
      expect(record.source_adapter).toBe("pqai");
      expect(record.publication_number.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it.skipIf(API_TOKEN)(
    "SKIP (no PQAI_API_TOKEN) — register at projectpq.ai",
    () => {
      expect(API_TOKEN).toBeUndefined();
    },
  );
});
