/**
 * @owner       src::adapters::unpaywall::works
 * @does        Registers Unpaywall DOI open-access lookup and source PDF read commands.
 * @needs       api.unpaywall.org v2, UNPAYWALL_EMAIL or --email, src/adapters/scholar-artifacts/pdf-read.ts, pdftotext
 * @feeds       src/commands/scholar.ts via scholar.pdf, scholar.get, and scholar.fulltext
 * @breaks      Missing email is an explicit invalid-input error; Unpaywall drift, missing best OA PDF URLs, or pdftotext failures surface as adapter errors.
 * @invariants  Only DOI-shaped references are accepted; best_oa_location is preferred for PDF and landing URLs; read requires a source-provided PDF URL.
 * @side-effects HTTPS egress to api.unpaywall.org and source PDF hosts; read writes one PDF and executes pdftotext.
 * @perf        O(1) DOI lookup plus O(PDF bytes + extracted page range) for read
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";
import { readScholarPdf } from "../scholar-artifacts/pdf-read.js";

const API = "https://api.unpaywall.org/v2";

type UnpaywallActionableError = Error & {
  code?: string;
  suggestion?: string;
  retryable?: boolean;
  alternatives?: string[];
};

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

function unpaywallInputError(
  message: string,
  suggestion: string,
): UnpaywallActionableError {
  const error = new Error(message) as UnpaywallActionableError;
  error.code = "invalid_input";
  error.suggestion = suggestion;
  error.retryable = false;
  error.alternatives = [];
  return error;
}

function unpaywallUpstreamError(
  message: string,
  retryable: boolean,
): UnpaywallActionableError {
  const error = new Error(message) as UnpaywallActionableError;
  error.code = "upstream_error";
  error.suggestion =
    "Unpaywall did not return a usable open-access response on this request; retry later, provide a valid requester email, or fall back to OpenAlex/Semantic Scholar.";
  error.retryable = retryable;
  error.alternatives = [];
  return error;
}

export function requireUnpaywallDoi(value: unknown): string {
  const doi = bareDoi(value);
  if (!/^10\.\S+\/\S+/.test(doi)) {
    throw unpaywallInputError(
      `unpaywall DOI "${String(value ?? "")}" is not recognised.`,
      "Pass a DOI such as 10.1038/nature12373 or https://doi.org/10.1038/nature12373.",
    );
  }
  return doi;
}

function requireEmail(value: unknown): string {
  const email = str(value) || process.env.UNPAYWALL_EMAIL?.trim() || "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw unpaywallInputError(
      "unpaywall lookup requires --email or UNPAYWALL_EMAIL.",
      "Pass --email <requester-email> to `unicli unpaywall oa`, or --unpaywall-email <requester-email> through `unicli scholar pdf/read/download`.",
    );
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

async function readUnpaywallWorkPdf(
  row: ScholarlyWorkRecord,
  kwargs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const pdfUrl = str(row.pdf_url);
  if (!pdfUrl) {
    throw new Error(`Unpaywall work ${row.id} has no source PDF URL.`);
  }
  return readScholarPdf(
    {
      ...kwargs,
      id: row.id,
      title: row.title,
      source_adapter: row.source_adapter,
      source_url: row.source_url,
      pdf_url: pdfUrl,
    },
    {
      site: "unpaywall",
      command: "read",
      defaultOutput: "./unpaywall-downloads",
      userAgent: "unicli-unpaywall/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  );
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
    throw unpaywallInputError(
      "Unpaywall rejected the email parameter.",
      "Provide a valid requester email address; Unpaywall requires a real contact email for API use.",
    );
  if (response.status === 429)
    throw unpaywallUpstreamError("Unpaywall returned HTTP 429.", true);
  if (!response.ok)
    throw unpaywallUpstreamError(
      `Unpaywall returned HTTP ${response.status}.`,
      response.status >= 500,
    );
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

cli({
  site: "unpaywall",
  name: "read",
  description: "Download an Unpaywall open-access PDF by DOI and extract text",
  domain: "api.unpaywall.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "doi", type: "str", required: true, positional: true },
    { name: "email", type: "str", description: "Unpaywall requester email" },
    {
      name: "output",
      type: "str",
      default: "./unpaywall-downloads",
      description: "Output directory for the downloaded PDF",
      "x-unicli-kind": "path",
    },
    { name: "filename", type: "str", description: "Output PDF filename" },
    { name: "first-page", type: "int", default: 1, description: "First page" },
    { name: "last-page", type: "int", default: 20, description: "Last page" },
    {
      name: "max-chars",
      type: "int",
      default: 40000,
      description: "Maximum extracted text characters",
    },
  ],
  columns: [
    "id",
    "title",
    "source_adapter",
    "source_url",
    "pdf_url",
    "path",
    "text_source",
    "text",
    "text_chars",
    "text_truncated",
  ],
  operation_family: "download",
  operation_effect: "download_file",
  capabilities: [
    "http.fetch",
    "http.download",
    "subprocess.exec",
    "scholar.fulltext",
    "scholar.pdf",
  ],
  executables: ["pdftotext"],
  minimum_capability: "subprocess.exec",
  func: async (_page, kwargs) => {
    const doi = requireUnpaywallDoi(kwargs.doi ?? kwargs.id ?? kwargs.ref);
    const email = requireEmail(kwargs.email);
    return [
      await readUnpaywallWorkPdf(
        mapUnpaywallWork(await fetchUnpaywall(doi, email), "unpaywall"),
        kwargs,
      ),
    ];
  },
});
