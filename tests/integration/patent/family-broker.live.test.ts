/**
 * @owner       tests::integration::patent::family-broker.live
 * @does        Live integration test of the EPO INPADOC family broker — gated on EPO_OPS_CLIENT_ID + EPO_OPS_CLIENT_SECRET; resolves the family of a known publication number (EP1000000A1) and asserts the response includes members from ≥2 jurisdictions.
 * @needs       src/engine/normalizer/patent-envelope.ts
 * @feeds       wave-2 hardening signal — `unicli patent family` brokers exclusively through EPO; this is the only path under test
 * @breaks      throws if token endpoint or family endpoint returns non-2xx; counts XML jurisdictions in-place rather than waiting for the YAML pipeline
 * @invariants  the test never runs without both env vars
 * @side-effects HTTPS to ops.epo.org (token + family)
 * @perf        two HTTPS requests
 * @concurrency safe
 * @test        self
 * @stability   experimental
 * @since       2026-05-18
 */

import { describe, expect, it } from "vitest";

const CLIENT_ID = process.env.EPO_OPS_CLIENT_ID;
const CLIENT_SECRET = process.env.EPO_OPS_CLIENT_SECRET;
const HAS_KEYS = Boolean(CLIENT_ID && CLIENT_SECRET);
const TOKEN_URL = "https://ops.epo.org/3.2/auth/accesstoken";
// EP1000000 is a well-known canonical test publication that EPO uses as a
// stable example across its documentation — its INPADOC family touches
// multiple jurisdictions, which is exactly the property we want to assert.
const FAMILY_URL =
  "https://ops.epo.org/3.2/rest-services/family/publication/docdb/EP.1000000.A1";

async function fetchAccessToken(): Promise<string> {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
    "base64",
  );
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (resp.status !== 200) {
    throw new Error(`EPO OPS token endpoint returned HTTP ${resp.status}`);
  }
  const json = (await resp.json()) as { access_token?: string };
  if (typeof json.access_token !== "string") {
    throw new Error("EPO OPS token response missing access_token field");
  }
  return json.access_token;
}

describe("family-broker.live — EPO INPADOC family resolves to ≥2 jurisdictions", () => {
  it.skipIf(!HAS_KEYS)(
    "EP1000000A1 family includes members from ≥2 jurisdictions",
    async () => {
      const token = await fetchAccessToken();
      const resp = await fetch(FAMILY_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/xml",
        },
      });
      // EPO returns 200 with XML when the family exists; 404 when EP1000000
      // has been retired in OPS. Honesty-first: surface 404 as a real fail
      // so the maintainer notices the upstream change and updates the
      // canonical publication number used by this test.
      expect(resp.status).toBe(200);
      const xml = await resp.text();

      // Extract distinct country codes from `country="XX"` attributes that
      // OPS attaches to every publication-reference inside the family. The
      // jurisdiction count is what `unicli patent family` ultimately
      // surfaces — assert ≥2 to lock the "covers multiple offices" promise.
      const matches = xml.match(/country="([A-Z]{2})"/g) ?? [];
      const jurisdictions = new Set(
        matches.map((m) => m.replace(/.*"([A-Z]{2})".*/, "$1")),
      );
      expect(jurisdictions.size).toBeGreaterThanOrEqual(2);
    },
    30_000,
  );

  it.skipIf(HAS_KEYS)(
    "SKIP (no EPO_OPS_CLIENT_ID / EPO_OPS_CLIENT_SECRET)",
    () => {
      expect(HAS_KEYS).toBe(false);
    },
  );
});
