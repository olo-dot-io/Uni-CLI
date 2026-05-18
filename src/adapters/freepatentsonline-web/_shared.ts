/**
 * @owner       src::adapters::freepatentsonline-web::_shared
 * @does        Shared HTTP + HTML helpers for the KEYLESS FreePatentsOnline adapter. FPO ships zero JS gate and zero auth; we hit the SSR `result.html` listing and `<id>.html` detail pages directly. Kind codes are decoded from FPO's internal URL routing — `/y<YYYY>/<serial>.html` ↔ US published application (ST.16 kind `A1`), `/<id>.html` (compact ID) ↔ US grant (kind code unknown from URL alone — skip), `/<CCNNNNkc>.html` ↔ explicit kind code (use as-is).
 * @needs       src/engine/normalizer/patent-envelope.ts, src/types/patent.ts, node:fetch (global)
 * @feeds       src/adapters/freepatentsonline-web/search.ts, src/adapters/freepatentsonline-web/get.ts
 * @breaks      throws FpoHttpError on non-2xx; pure-HTML parse functions never throw, they return null on selector miss
 * @invariants  every outbound request carries a real-browser User-Agent; publication numbers either arrive with an explicit kind code OR are decoded from FPO's URL convention — adapters NEVER fabricate a kind code from era heuristics
 * @side-effects HTTPS egress to www.freepatentsonline.com only
 * @perf        50-150 KB per page; HTML parse is linear regex
 * @concurrency safe — stateless
 * @test        verification proof in docs/skills/patent-cookbook.md
 * @stability   experimental
 * @since       2026-05-18
 * @verification keyless-best-effort
 */

const FPO_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

export const FPO_ORIGIN = "https://www.freepatentsonline.com";

export class FpoHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "FpoHttpError";
  }
}

export async function fetchFpoHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": FPO_UA,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) {
    throw new FpoHttpError(
      response.status,
      url,
      `FreePatentsOnline returned HTTP ${response.status}`,
    );
  }
  return await response.text();
}

export function buildFpoSearchUrl(query: string, page: number): string {
  const trimmed = query.trim().replace(/\s+/g, "+");
  const safe = encodeURIComponent(trimmed).replace(/%2B/g, "+");
  return `${FPO_ORIGIN}/result.html?p=${page}&sort=relevance&srch=xprtsrch&query_txt=${safe}&submitted=&patents_us=on&patents_other=on`;
}

export function buildFpoDetailUrl(publicationNumber: string): string {
  const compact = publicationNumber.replace(/-/g, "").toUpperCase();
  // Heuristic for US published applications: `US20240220787` → `/y2024/0220787.html`
  const usAppMatch = /^US(\d{4})(\d{7})$/.exec(compact);
  if (usAppMatch) {
    return `${FPO_ORIGIN}/y${usAppMatch[1]}/${usAppMatch[2]}.html`;
  }
  // EP / WO / etc with explicit kind code → /<full>.html
  return `${FPO_ORIGIN}/${encodeURIComponent(compact)}.html`;
}

/**
 * Convert an MM/DD/YYYY date as FPO renders it into ISO-8601 YYYY-MM-DD.
 * Returns undefined on shape mismatch — we never invent a date.
 */
export function fpoDateToIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^\s*(\d{2})\/(\d{2})\/(\d{4})\s*$/.exec(raw);
  if (!match) return undefined;
  return `${match[3]}-${match[1]}-${match[2]}`;
}

const TAG_RE = /<[^>]+>/g;
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&hellip;": "…",
  "&nbsp;": " ",
};

export function stripFpoHtml(input: string | undefined | null): string {
  if (!input) return "";
  return input
    .replace(TAG_RE, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|hellip|nbsp);/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Search-result row as scraped from the FPO listing table. Kind code is
 * decoded from the link path; rows whose link does not encode a kind code
 * are dropped at the search-adapter level rather than fabricated.
 */
export interface FpoListingRow {
  publication_number_raw: string;
  publication_number_canonical?: string;
  title: string;
  abstract?: string;
  detail_url: string;
}

const LISTING_TABLE_RE =
  /<table[^>]*class="listing_table"[^>]*>([\s\S]*?)<\/table>/i;
const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<td[^>]*>([\s\S]*?)<\/td>/gi;
const HREF_RE = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;

/**
 * Map an FPO listing link path to a canonical ST.16 publication number when
 * the route encodes enough information. Returns undefined when the route
 * is structurally ambiguous (e.g. bare grant numbers without a CC prefix).
 */
export function canonicaliseFpoLink(
  link: string,
  rawPubNo: string,
): string | undefined {
  // Already segmented? e.g. "EP3716153A1" or "WO2024012345A1"
  const explicit = /^([A-Z]{2})(\d+)([A-Z]\d?)$/.exec(
    rawPubNo.replace(/\s+/g, "").toUpperCase(),
  );
  if (explicit) {
    return `${explicit[1]}-${explicit[2]}-${explicit[3]}`;
  }
  // US application route: /y<YYYY>/<NNNNNNN>.html ↔ US-YYYYNNNNNNN-A1
  const usAppMatch = /^\/y(\d{4})\/(\d{7})\.html$/i.exec(link);
  if (usAppMatch) {
    return `US-${usAppMatch[1]}${usAppMatch[2]}-A1`;
  }
  return undefined;
}

export function parseFpoListing(html: string): FpoListingRow[] {
  const tableMatch = LISTING_TABLE_RE.exec(html);
  if (!tableMatch) return [];
  const body = tableMatch[1];
  ROW_RE.lastIndex = 0;
  const out: FpoListingRow[] = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = ROW_RE.exec(body)) !== null) {
    const cells: string[] = [];
    CELL_RE.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = CELL_RE.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1]);
    }
    // FPO 2026 layout: <tr> has 4 <td> cells —
    //   cells[0] = match index ("1", "2", ...)
    //   cells[1] = publication number text (e.g. "US20240220787")
    //   cells[2] = <a href>title</a> &nbsp; <br/> abstract-snippet
    //   cells[3] = relevance score
    if (cells.length < 3) continue;
    const rawPubNo = stripFpoHtml(cells[1]);
    const titleCell = cells[2];
    const link = HREF_RE.exec(titleCell);
    if (!rawPubNo || !link) continue;
    const title = stripFpoHtml(link[2]);
    // Abstract snippet is the remainder of cells[2] after the </a> tag —
    // FPO emits it inline after a &nbsp; and a <br/>. Strip the <a>…</a>
    // block plus the trailing <br/> and treat what's left as the snippet.
    const afterAnchor = titleCell
      .replace(HREF_RE, "")
      .replace(/<br\s*\/?>/i, "");
    const abstractSnippet = stripFpoHtml(afterAnchor);
    out.push({
      publication_number_raw: rawPubNo,
      publication_number_canonical: canonicaliseFpoLink(link[1], rawPubNo),
      title,
      abstract: abstractSnippet || undefined,
      detail_url: link[1].startsWith("http")
        ? link[1]
        : `${FPO_ORIGIN}${link[1]}`,
    });
  }
  return out;
}

/**
 * Bibliographic detail fields parsed from a single FPO patent page. Empty
 * fields are `undefined`, never `null` and never invented.
 */
export interface FpoDetail {
  title?: string;
  abstract?: string;
  publication_number?: string;
  application_number?: string;
  publication_date?: string;
  filing_date?: string;
  assignee?: string;
  kind_code?: string;
  doc_type_label?: string;
}

const KIND_CODE_RE =
  /<div[^>]*disp_elm_name_kcode[^>]*>[\s\S]*?Kind\s*Code:[\s\S]*?<\/div>\s*<div[^>]*float_left[^>]*>\s*([A-Z0-9]+)\s*<\/div>/i;
const DOC_TYPE_RE =
  /<div[^>]*disp_elm_text[^>]*style="[^"]*clear:\s*none[^"]*"[^>]*>\s*<label[^>]*>\s*([^<]+?)\s*<\/label>/i;

function extractLabelValue(html: string, label: string): string | undefined {
  const re = new RegExp(
    `<div[^>]*disp_elm_title[^>]*>\\s*${label}\\s*:?\\s*<\\/div>\\s*<div[^>]*disp_elm_text[^>]*>([\\s\\S]*?)<\\/div>`,
    "i",
  );
  const match = re.exec(html);
  if (!match) return undefined;
  const value = stripFpoHtml(match[1]);
  return value || undefined;
}

export function parseFpoDetail(html: string): FpoDetail {
  const title = extractLabelValue(html, "Title");
  const abstractRaw = extractLabelValue(html, "Abstract");
  const applicationNumber = extractLabelValue(html, "Application Number");
  const publicationDate = fpoDateToIso(
    extractLabelValue(html, "Publication Date"),
  );
  const filingDate = fpoDateToIso(extractLabelValue(html, "Filing Date"));
  const assignee = extractLabelValue(html, "Assignee");
  const kindMatch = KIND_CODE_RE.exec(html);
  const kindCode = kindMatch ? kindMatch[1].toUpperCase() : undefined;
  const docTypeMatch = DOC_TYPE_RE.exec(html);
  const docTypeLabel = docTypeMatch ? docTypeMatch[1].trim() : undefined;

  return {
    title,
    abstract: abstractRaw,
    application_number: applicationNumber,
    publication_date: publicationDate,
    filing_date: filingDate,
    assignee,
    kind_code: kindCode,
    doc_type_label: docTypeLabel,
  };
}

/**
 * Combine the bib label `United States Patent Application 20240220787` and
 * the kind code `A1` extracted separately into the canonical ST.16 form
 * `US-20240220787-A1`. Returns undefined if either piece is missing.
 */
export function reconstructCanonicalPubNo(
  docTypeLabel: string | undefined,
  kindCode: string | undefined,
): string | undefined {
  if (!docTypeLabel || !kindCode) return undefined;
  // Pull the trailing identifier off the label. The label is one of:
  //   "United States Patent Application 20240220787"  (11-digit US app id)
  //   "European Patent Application EP3716153"          (CC-prefixed)
  //   "United States Patent 12602228"                  (7-9 digit US grant)
  const idMatch = /([A-Z]{2}\d+|\d{7,})\s*$/.exec(docTypeLabel.trim());
  if (!idMatch) return undefined;
  const rawId = idMatch[1];
  // Prefix? `US…`, `EP…`, etc. — strip then re-emit
  const prefixMatch = /^([A-Z]{2})(\d+)$/.exec(rawId);
  if (prefixMatch) {
    return `${prefixMatch[1]}-${prefixMatch[2]}-${kindCode}`;
  }
  // Bare numeric — could be a 7-9 digit US grant or an 11-digit US
  // published-application identifier. Both belong to the US namespace.
  if (/^\d{7,11}$/.test(rawId)) {
    return `US-${rawId}-${kindCode}`;
  }
  return undefined;
}
