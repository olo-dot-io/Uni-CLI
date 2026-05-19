/**
 * @owner       src::adapters::unpaywall::works
 * @does        Registers Unpaywall DOI open-access lookup for PDF availability.
 * @needs       api.unpaywall.org v2, UNPAYWALL_EMAIL or --email, src/registry.ts
 * @feeds       src/commands/scholar.ts via scholar.pdf and scholar.get
 * @breaks      Missing email is an explicit invalid-input error; Unpaywall drift surfaces as adapter error, never as a fabricated PDF.
 * @invariants  Only DOI-shaped references are accepted; best_oa_location is preferred for PDF and landing URLs.
 * @side-effects HTTPS egress to api.unpaywall.org only
 * @perf        O(1) per DOI
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const API = "https://api.unpaywall.org/v2";

interface OaLocation {
  url_for_pdf?: unknown;
  url_for_landing_page?: unknown;
  host_type?: unknown;
  version?: unknown;
  license?: unknown;
}

interface UnpaywallWork {
  doi?: unknown;
  title?: unknown;
  is_oa?: unknown;
  oa_status?: unknown;
  best_oa_location?: OaLocation | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bareDoi(value: unknown): string {
  return str(value)
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

export function requireUnpaywallDoi(value: unknown): string {
  const doi = bareDoi(value);
  if (!/^10\.\S+\/\S+/.test(doi)) {
    throw new Error(
      `unpaywall DOI "${String(value ?? "")}" is not recognised.`,
    );
  }
  return doi;
}

function requireEmail(value: unknown): string {
  const email = str(value) || process.env.UNPAYWALL_EMAIL?.trim() || "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("unpaywall lookup requires --email or UNPAYWALL_EMAIL.");
  }
  return email;
}

export function mapUnpaywallWork(
  work: UnpaywallWork,
  source: string,
): ScholarlyWorkRecord {
  const doi = requireUnpaywallDoi(work.doi);
  const best = work.best_oa_location ?? {};
  return {
    id: doi,
    title: str(work.title),
    doi,
    is_open_access: work.is_oa === true,
    oa_status: str(work.oa_status) || undefined,
    pdf_url: str(best.url_for_pdf) || undefined,
    landing_url: str(best.url_for_landing_page) || `https://doi.org/${doi}`,
    type:
      [str(best.host_type), str(best.version), str(best.license)]
        .filter(Boolean)
        .join(":") || undefined,
    source_adapter: source,
    source_url: str(best.url_for_landing_page) || `https://doi.org/${doi}`,
    retrieved_at: new Date().toISOString(),
  };
}

async function fetchUnpaywall(
  doi: string,
  email: string,
): Promise<UnpaywallWork> {
  const response = await fetch(
    `${API}/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "unicli-unpaywall/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      },
    },
  );
  if (response.status === 404)
    throw new Error(`Unpaywall returned no result for ${doi}.`);
  if (response.status === 422)
    throw new Error("Unpaywall rejected the email parameter.");
  if (response.status === 429) throw new Error("Unpaywall returned HTTP 429.");
  if (!response.ok)
    throw new Error(`Unpaywall returned HTTP ${response.status}.`);
  return response.json() as Promise<UnpaywallWork>;
}

cli({
  site: "unpaywall",
  name: "oa",
  description: "Find open-access PDF availability for a DOI via Unpaywall",
  domain: "api.unpaywall.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "doi", type: "str", required: true, positional: true },
    { name: "email", type: "str", description: "Unpaywall requester email" },
  ],
  columns: [
    "id",
    "title",
    "doi",
    "is_open_access",
    "oa_status",
    "pdf_url",
    "source_url",
  ],
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const doi = requireUnpaywallDoi(kwargs.doi ?? kwargs.id ?? kwargs.ref);
    const email = requireEmail(kwargs.email);
    return [mapUnpaywallWork(await fetchUnpaywall(doi, email), "unpaywall")];
  },
});
