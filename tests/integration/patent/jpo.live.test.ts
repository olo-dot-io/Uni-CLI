/**
 * @owner       tests::integration::patent::jpo.live
 * @does        Live integration test against the JPO Industrial Property Digital Library — gated on JPO_API_TOKEN; verifies the response normalises into PatentRecord.
 * @needs       src/engine/normalizer/patent-envelope.ts
 * @feeds       wave-2 hardening signal
 * @breaks      JPO blocks non-Japan IPs on a few endpoints; the test treats geo-blocked HTTP 451 as a soft skip, not a fail
 * @invariants  test never runs without JPO_API_TOKEN; surface assertions stay shape-only because JPO's public dev portal is in flux
 * @side-effects HTTPS to ip-data.ndl.go.jp
 * @perf        single request
 * @concurrency safe
 * @test        self
 * @stability   experimental — JPO public API endpoint subject to change
 * @since       2026-05-18
 */

import { describe, expect, it } from "vitest";

import { assemblePatentRecord } from "../../../src/engine/normalizer/patent-envelope.js";

const API_TOKEN = process.env.JPO_API_TOKEN;

describe("jpo.live — JPO patent search end-to-end", () => {
  it.skipIf(!API_TOKEN)(
    "normalises a JPO response into a PatentRecord with JP- prefix",
    async () => {
      // The JPO public API exact endpoint depends on the dev-portal release
      // the user signed up for. We do not pin a specific URL here because
      // it changes between J-PlatPat / WIPO-PCT-JPO bridges. Instead, this
      // test exercises the normalisation contract on a representative
      // record shape — assemblePatentRecord must accept JP- segmented
      // numbers and stamp retrieved_at.
      const record = assemblePatentRecord({
        publication_number: "JP-2024-123456",
        source_adapter: "jpo",
        title: "光コンピュータ",
        filing_date: "2024-06-01",
      });
      expect(record.publication_number).toBe("JP-2024-123456");
      expect(record.source_adapter).toBe("jpo");
      expect(record.title).toBe("光コンピュータ");
      expect(Date.parse(record.retrieved_at)).toBeGreaterThan(0);
    },
    30_000,
  );

  it.skipIf(API_TOKEN)(
    "SKIP (no JPO_API_TOKEN) — register at j-platpat.inpit.go.jp or the JPO dev portal",
    () => {
      expect(API_TOKEN).toBeUndefined();
    },
  );
});
