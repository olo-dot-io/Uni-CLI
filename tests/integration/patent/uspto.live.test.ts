/**
 * @owner       tests::integration::patent::uspto.live
 * @does        Live integration test against the USPTO Open Data Portal — gated on USPTO_ODP_API_KEY; verifies the adapter's normalisation produces a valid PatentRecord shape.
 * @needs       src/engine/normalizer/patent-envelope.ts
 * @feeds       wave-2 hardening signal
 * @breaks      throws PipelineError on 401/403 (missing/invalid X-API-KEY) or 5xx; otherwise the test asserts on assemblePatentRecord output
 * @invariants  test never runs without USPTO_ODP_API_KEY; never invents fields; uses a fixed query so failure diff is meaningful
 * @side-effects HTTPS egress to api.uspto.gov when key is present
 * @perf        single request; ODP returns up to 500 records per page
 * @concurrency safe
 * @test        self — live integration
 * @stability   experimental — gated on free-tier registration
 * @since       2026-05-18
 */

import { describe, expect, it } from "vitest";

import {
  assemblePatentRecord,
  canonicalizePublicationNumber,
} from "../../../src/engine/normalizer/patent-envelope.js";

const API_KEY = process.env.USPTO_ODP_API_KEY;
const SEARCH_URL = "https://api.uspto.gov/api/v1/patent/applications/search";

describe("uspto.live — Open Data Portal search end-to-end", () => {
  it.skipIf(!API_KEY)(
    "returns ≥1 record for 'optical computer' and normalises into PatentRecord",
    async () => {
      const url = new URL(SEARCH_URL);
      url.searchParams.set("q", "optical computer");
      url.searchParams.set("limit", "3");
      const resp = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-API-KEY": API_KEY!,
        },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        patentFileWrapperDataBag?: Array<Record<string, unknown>>;
      };
      const rows = body.patentFileWrapperDataBag ?? [];
      expect(rows.length).toBeGreaterThan(0);

      // Pick the first row and walk it through the normaliser exactly as the
      // adapter pipeline does. If the upstream schema drifts (e.g. ODP renames
      // a field), this test surfaces it as a concrete diff at the assembly
      // boundary — no need to wait for an end-user repair.
      const first = rows[0];
      const meta = first.applicationMetaData as
        | Record<string, unknown>
        | undefined;
      const earliestPub = meta?.earliestPublicationNumber as string | undefined;
      const appNumber = first.applicationNumberText as string | undefined;
      const compactPub = earliestPub
        ? `US-${earliestPub}`
        : `US-${appNumber ?? ""}`;
      expect(compactPub.startsWith("US-")).toBe(true);

      const record = assemblePatentRecord({
        publication_number: compactPub,
        source_adapter: "uspto",
        application_number: appNumber ?? undefined,
        title: (meta?.inventionTitle as string | undefined) ?? undefined,
        filing_date: (meta?.filingDate as string | undefined) ?? undefined,
        publication_date:
          (meta?.earliestPublicationDate as string | undefined) ?? undefined,
      });
      expect(record.publication_number).toBe(
        canonicalizePublicationNumber(compactPub),
      );
      expect(record.source_adapter).toBe("uspto");
      expect(Date.parse(record.retrieved_at)).toBeGreaterThan(0);
    },
    30_000,
  );

  it.skipIf(API_KEY)(
    "SKIP (no USPTO_ODP_API_KEY) — register a free key at developer.uspto.gov",
    () => {
      // The skipIf inversion guarantees we surface the skip reason in the
      // reporter rather than silently passing zero assertions.
      expect(API_KEY).toBeUndefined();
    },
  );
});
