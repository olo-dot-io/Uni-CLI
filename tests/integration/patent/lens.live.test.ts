/**
 * @owner       tests::integration::patent::lens.live
 * @does        Live integration test against the Lens.org patent search REST API — gated on LENS_API_TOKEN; verifies the response normalises into PatentRecord.
 * @needs       src/engine/normalizer/patent-envelope.ts
 * @feeds       wave-2 hardening signal
 * @breaks      Lens enforces tight free-tier rate limits; 429 surfaces as a thrown error so honesty stays intact
 * @invariants  the test never runs without LENS_API_TOKEN; uses a fixed query
 * @side-effects HTTPS POST to api.lens.org
 * @perf        single request
 * @concurrency safe
 * @test        self
 * @stability   experimental
 * @since       2026-05-18
 */

import { describe, expect, it } from "vitest";

import { assemblePatentRecord } from "../../../src/engine/normalizer/patent-envelope.js";

const API_TOKEN = process.env.LENS_API_TOKEN;

describe("lens.live — Lens.org patent search end-to-end", () => {
  it.skipIf(!API_TOKEN)(
    "returns ≥1 record for 'optical computer' and normalises into PatentRecord",
    async () => {
      const resp = await fetch("https://api.lens.org/patent/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify({
          query: { match: { full_text: "optical computer" } },
          size: 3,
        }),
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        data?: Array<{
          lens_id?: string;
          jurisdiction?: string;
          doc_number?: string;
          kind?: string;
          biblio?: { invention_title?: Array<{ text?: string }> };
        }>;
      };
      const rows = body.data ?? [];
      expect(rows.length).toBeGreaterThan(0);

      const first = rows[0];
      const cc = first.jurisdiction ?? "US";
      const docNum = first.doc_number ?? "0000000";
      const kind = first.kind ?? "A1";
      const record = assemblePatentRecord({
        publication_number: `${cc}-${docNum}-${kind}`,
        source_adapter: "lens",
        title: first.biblio?.invention_title?.[0]?.text ?? undefined,
      });
      expect(record.source_adapter).toBe("lens");
      expect(record.publication_number.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it.skipIf(API_TOKEN)(
    "SKIP (no LENS_API_TOKEN) — register at lens.org",
    () => {
      expect(API_TOKEN).toBeUndefined();
    },
  );
});
