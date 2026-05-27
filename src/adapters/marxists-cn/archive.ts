/**
 * @owner   src/adapters/marxists-cn/archive.ts
 * @does    Register agent-facing Chinese Marxists Internet Archive index, works, search, read, and reading-list commands.
 * @needs   Public www.marxists.org/chinese HTML, GB18030 decoding, bounded archive crawling.
 * @feeds   surface coverage ledger, Marxist philosophy, Western Marxism, and socialist-history retrieval workflows.
 * @breaks  Charset drift, silent off-site URLs, or weak crawl bounds hide primary-source archive content.
 * @invariants All fetched pages are constrained to https://www.marxists.org/chinese/.
 * @side-effects Performs public HTTP GET requests only.
 * @perf    Search crawls bounded author/topic index pages and optionally bounded full-text pages.
 * @concurrency Search fetches index pages in small batches to avoid hammering the archive.
 * @test    src/adapters/marxists-cn/archive.test.ts
 * @stability stable
 * @since   0.224.0
 */

import { decodeHtmlEntities } from "../../engine/text-normalize.js";
import { cli, Strategy } from "../../registry.js";

const MARXISTS_CN_BASE = "https://www.marxists.org/chinese/";
const MARXISTS_HOST = "www.marxists.org";
const USER_AGENT =
  "unicli-marxists-cn/1.0 (https://github.com/olo-dot-io/Uni-CLI)";
const INDEX_COLUMNS = ["rank", "title", "latinName", "kind", "path", "url"];
const WORK_COLUMNS = [
  "rank",
  "scope",
  "section",
  "title",
  "note",
  "format",
  "path",
  "url",
];
const SEARCH_COLUMNS = [
  "rank",
  "type",
  "scope",
  "section",
  "title",
  "snippet",
  "path",
  "url",
  "score",
];
const READ_COLUMNS = ["title", "author", "date", "chars", "text", "url"];
const READING_LIST_COLUMNS = [
  "rank",
  "preset",
  "author",
  "title",
  "year",
  "theme",
  "path",
  "url",
  "readCommand",
  "note",
];

interface ReadingListItem {
  preset: string;
  author: string;
  title: string;
  year: string;
  theme: string;
  path: string;
  url: string;
  readCommand: string;
  note: string;
}

const WESTERN_MARXISM_PRESET = "western-marxism";
const WESTERN_MARXISM_READINGS = [
  {
    author: "葛兰西",
    title: "《现代君主论》",
    year: "1931-1934",
    theme: "hegemony-party-state",
    path: "gramsci/1931-1934/index.htm",
    note: "站内 HTML 目录；适合作为葛兰西政治理论入口。",
  },
  {
    author: "葛兰西",
    title: "《狱中札记》选读：马克思主义问题",
    year: "1929-1935",
    theme: "praxis-hegemony",
    path: "gramsci/marxist/index.htm",
    note: "站内标注为译自《狱中札记》的专题选读。",
  },
  {
    author: "卢卡奇",
    title: "《历史与阶级意识》",
    year: "1922",
    theme: "reification-class-consciousness",
    path: "georg-lukacs/1922/index.htm",
    note: "站内 HTML 目录；西方马克思主义常用起点。",
  },
  {
    author: "卢卡奇",
    title: "《列宁——关于列宁思想统一性的研究》",
    year: "1924",
    theme: "party-dialectics",
    path: "georg-lukacs/1924/index.htm",
    note: "站内 HTML 目录；与《历史与阶级意识》配套阅读。",
  },
  {
    author: "科尔施",
    title: "《马克思主义与哲学》",
    year: "1923",
    theme: "marxism-philosophy",
    path: "korsch-karl/mia-chinese-korsch-karl-1923.htm",
    note: "站内 HTML 正文；早期西方马克思主义核心文本。",
  },
  {
    author: "本雅明",
    title: "《机械复制时代的艺术作品》",
    year: "1936",
    theme: "aesthetics-technology",
    path: "walter-benjamin/mia-chinese-walter-benjamin-1936.htm",
    note: "站内 HTML 正文；文化与技术批判入口。",
  },
  {
    author: "本雅明",
    title: "《历史哲学论纲》",
    year: "1940",
    theme: "history-messianism",
    path: "walter-benjamin/mia-chinese-walter-benjamin-1940.htm",
    note: "站内 HTML 正文；历史哲学短文本。",
  },
  {
    author: "阿多诺",
    title: "《文化工业再思考》",
    year: "1967",
    theme: "frankfurt-culture-industry",
    path: "adorno/mia-chinese-adorno-1967.htm",
    note: "站内 HTML 正文；法兰克福学派文化批判入口。",
  },
  {
    author: "马尔库塞",
    title: "《单向度的人》",
    year: "1964",
    theme: "advanced-industrial-society",
    path: "marcuse/marxist.org-chinese-marcuse-1964.htm",
    note: "站内 HTML 正文；发达工业社会意识形态批判。",
  },
  {
    author: "马尔库塞",
    title: "《苏联的马克思主义——一种批判的分析》",
    year: "1958",
    theme: "soviet-marxism",
    path: "marcuse/1958/index.htm",
    note: "站内 HTML 目录；与其社会批判文本互补。",
  },
  {
    author: "阿尔都塞",
    title: "《保卫马克思》",
    year: "1965",
    theme: "structural-marxism",
    path: "althusser/1965/index.htm",
    note: "站内 HTML 目录；结构主义马克思主义入口。",
  },
  {
    author: "阿尔都塞",
    title: "《意识形态和意识形态国家机器》",
    year: "1970",
    theme: "ideology-state-apparatuses",
    path: "althusser/mia-chinese-althusser-197004.htm",
    note: "站内 HTML 正文；意识形态理论核心文本。",
  },
  {
    author: "曼德尔",
    title: "《论马克思主义经济学》",
    year: "1962",
    theme: "marxist-economics",
    path: "ernest-mandel/1962book/index.htm",
    note: "站内 HTML 目录；马克思主义经济学导论性文本。",
  },
  {
    author: "曼德尔",
    title: "《晚期资本主义》序言",
    year: "1975",
    theme: "late-capitalism",
    path: "ernest-mandel/mia-chinese-mandel-1975.htm",
    note: "站内 HTML 正文；完整书另有 PDF，HTML 入口可直接读。",
  },
] as const;

interface Anchor {
  href: string;
  text: string;
  title: string;
  rawAfter: string;
}

interface ArchiveLink {
  title: string;
  latinName: string;
  kind: string;
  path: string;
  url: string;
}

interface WorkLink {
  scope: string;
  section: string;
  title: string;
  note: string;
  format: string;
  path: string;
  url: string;
}

interface SearchCandidate {
  type: string;
  scope: string;
  section: string;
  title: string;
  snippet: string;
  path: string;
  url: string;
  score: number;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanInlineText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?，。；：！？、）】])/g, "$1")
    .replace(/([（【])\s+/g, "$1")
    .trim();
}

function cleanBlockText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeAttribute(value: string): string {
  return decodeHtmlEntities(value.replace(/\s+/g, " ")).trim();
}

function htmlAttribute(attrs: string, name: string): string {
  const re = new RegExp(
    `${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = attrs.match(re);
  return decodeAttribute(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function imageAlt(inner: string): string {
  const match = inner.match(/<img\b([^>]*)>/i);
  return match ? htmlAttribute(match[1], "alt") : "";
}

export function requireMarxistsLimit(
  value: unknown,
  fallback: number,
  max: number,
  label: string,
): number {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`marxists-cn ${label} must be an integer in [1, ${max}].`);
  }
  return n;
}

function boolArg(value: unknown): boolean {
  if (value === true || value === false) return value;
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text === "1" || text === "true" || text === "yes";
}

export function normalizeMarxistsPath(
  value: unknown,
  options: { directoryIndex?: boolean } = {},
): string {
  let raw = String(value ?? "").trim();
  if (!raw) raw = "index.html";
  let url: URL;
  if (/^https?:\/\//i.test(raw)) {
    url = new URL(raw);
  } else {
    raw = raw.replace(/^\/+/, "");
    if (raw.startsWith("chinese/")) raw = raw.slice("chinese/".length);
    if (options.directoryIndex && !/\.[a-z0-9]{1,8}(?:[#?].*)?$/i.test(raw)) {
      raw = `${raw.replace(/\/+$/, "")}/index.htm`;
    }
    url = new URL(raw, MARXISTS_CN_BASE);
  }
  if (url.hostname !== MARXISTS_HOST) {
    throw new Error(`marxists-cn URL must stay on ${MARXISTS_HOST}.`);
  }
  if (!url.pathname.startsWith("/chinese/")) {
    throw new Error("marxists-cn URL must stay under /chinese/.");
  }
  url.protocol = "https:";
  url.hash = "";
  url.search = "";
  const path = decodeURIComponent(url.pathname.slice("/chinese/".length));
  if (!path || path.includes("\0") || path.split("/").includes("..")) {
    throw new Error("marxists-cn path is not valid.");
  }
  return path;
}

export function marxistsUrl(path: string): string {
  const url = new URL(path, MARXISTS_CN_BASE);
  if (url.hostname !== MARXISTS_HOST || !url.pathname.startsWith("/chinese/")) {
    throw new Error("marxists-cn resolved URL left the Chinese archive.");
  }
  url.protocol = "https:";
  url.hash = "";
  url.search = "";
  return url.toString();
}

function linkPath(href: string, baseUrl: string): string | null {
  if (!href || /^(?:#|mailto:|javascript:)/i.test(href)) return null;
  try {
    return normalizeMarxistsPath(new URL(href, baseUrl).toString());
  } catch {
    return null;
  }
}

function fileFormat(path: string): string {
  const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return ext ?? "html";
}

function archiveKind(path: string): string {
  const format = fileFormat(path);
  if (["pdf", "chm", "mp3", "zip", "rar"].includes(format)) return format;
  if (/^(?:search|update|whoweare)\//.test(path)) return "site-meta";
  if (/^(?:abc|dictionary-of-marxism|reference-books)\//.test(path)) {
    return "reference";
  }
  if (path.startsWith("pdf/")) return "library";
  if (/\/index\.html?$/i.test(path) || /\/index\.htm$/i.test(path)) {
    return "directory";
  }
  return "html";
}

function latinName(title: string, visibleText: string): string {
  const source = title || visibleText;
  const match = source.match(/[A-Za-z][A-Za-z0-9 .,'’\-·]+$/);
  return match ? match[0].trim() : "";
}

function displayTitle(anchor: Anchor): string {
  const title = anchor.text || anchor.title;
  const latin = latinName(anchor.title, anchor.text);
  return latin && title.endsWith(latin)
    ? title.slice(0, -latin.length).trim()
    : title;
}

export function extractMarxistsAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const matches = Array.from(html.matchAll(re));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const startAfter = (match.index ?? 0) + match[0].length;
    const endAfter = matches[index + 1]?.index ?? html.length;
    const text = cleanInlineText(inner) || imageAlt(inner);
    anchors.push({
      href: htmlAttribute(attrs, "href"),
      title: htmlAttribute(attrs, "title"),
      text,
      rawAfter: html.slice(startAfter, endAfter),
    });
  }
  return anchors;
}

export function parseMarxistsIndex(
  html: string,
  baseUrl = MARXISTS_CN_BASE,
): ArchiveLink[] {
  const rows: ArchiveLink[] = [];
  const seen = new Set<string>();
  for (const anchor of extractMarxistsAnchors(html)) {
    const path = linkPath(anchor.href, baseUrl);
    const title = displayTitle(anchor);
    if (!path || !title || seen.has(path)) continue;
    seen.add(path);
    rows.push({
      title,
      latinName: latinName(anchor.title, anchor.text),
      kind: archiveKind(path),
      path,
      url: marxistsUrl(path),
    });
  }
  return rows;
}

function sectionFromSegment(segment: string): string {
  const matches = Array.from(
    segment.matchAll(
      /<font\b(?=[^>]*\bsize\s*=\s*["']?5\b)[^>]*>([\s\S]*?)<\/font>|<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/gi,
    ),
  );
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const text = cleanInlineText(matches[i][1] ?? matches[i][2] ?? "");
    if (text && text.length <= 80) return text;
  }
  return "";
}

function noteFromSegment(segment: string): string {
  return cleanInlineText(
    segment.replace(/<a\b[\s\S]*?<\/a>/gi, " ").replace(/<br\s*\/?>/gi, "\n"),
  ).slice(0, 240);
}

export function parseMarxistsWorks(
  html: string,
  scope: string,
  baseUrl: string,
): WorkLink[] {
  const anchors = extractMarxistsAnchors(html);
  const rows: WorkLink[] = [];
  const seen = new Set<string>();
  let section = "";
  let previousEnd = 0;
  const anchorMatches = Array.from(html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi));

  for (let index = 0; index < anchors.length; index += 1) {
    const match = anchorMatches[index];
    const before = html.slice(previousEnd, match?.index ?? previousEnd);
    const nextSection = sectionFromSegment(before);
    if (nextSection) section = nextSection;
    previousEnd = (match?.index ?? 0) + (match?.[0].length ?? 0);

    const anchor = anchors[index];
    const path = linkPath(anchor.href, baseUrl);
    const title = displayTitle(anchor);
    if (
      !path ||
      !title ||
      seen.has(path) ||
      path === scope ||
      path === "index.html"
    ) {
      continue;
    }
    seen.add(path);
    rows.push({
      scope,
      section,
      title,
      note: noteFromSegment(anchor.rawAfter),
      format: fileFormat(path),
      path,
      url: marxistsUrl(path),
    });
  }
  return rows;
}

function htmlTitle(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return cleanInlineText(title);
}

function classText(html: string, className: string): string {
  const re = new RegExp(
    `<[^>]+class\\s*=\\s*["']${className}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "i",
  );
  return cleanInlineText(html.match(re)?.[1] ?? "");
}

export function marxistsHtmlToText(html: string): string {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return cleanBlockText(
    body
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|blockquote|h[1-6]|li|tr|pre)>/gi, "\n")
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n"),
  );
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}\n\n... [truncated]`
    : text;
}

export function mapMarxistsReadRow(
  html: string,
  url: string,
  maxLength: number,
): Record<string, unknown> {
  const text = marxistsHtmlToText(html);
  if (!text) throw new Error("marxists-cn read produced no text.");
  return {
    title: classText(html, "title0") || htmlTitle(html),
    author: classText(html, "author"),
    date: classText(html, "date"),
    chars: text.length,
    text: truncateText(text, maxLength),
    url,
  };
}

function sniffCharset(buffer: ArrayBuffer, contentType: string): string {
  const headerMatch = contentType.match(/charset=([^;\s]+)/i);
  if (headerMatch) return headerMatch[1].toLowerCase();
  const prefix = new TextDecoder("latin1").decode(buffer.slice(0, 4096));
  const metaMatch = prefix.match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i);
  return metaMatch ? metaMatch[1].toLowerCase() : "gb18030";
}

export function decodeMarxistsBuffer(
  buffer: ArrayBuffer,
  contentType = "",
): string {
  const charset = sniffCharset(buffer, contentType);
  if (/utf-?8/.test(charset)) return new TextDecoder("utf-8").decode(buffer);
  if (/gb2312|gbk|gb18030|big5/.test(charset)) {
    return new TextDecoder("gb18030").decode(buffer);
  }
  return new TextDecoder("gb18030").decode(buffer);
}

async function fetchArchiveHtml(path: string): Promise<string> {
  const url = marxistsUrl(path);
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,text/plain",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
  });
  if (response.status === 404) {
    throw new Error(`marxists-cn path not found: ${path}.`);
  }
  if (!response.ok) {
    throw new Error(`marxists-cn returned HTTP ${response.status} for ${url}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|text\/plain|application\/xhtml\+xml|^$/i.test(contentType)) {
    throw new Error(
      `marxists-cn read only supports text/html pages, got ${contentType || "unknown"} for ${path}.`,
    );
  }
  return decodeMarxistsBuffer(await response.arrayBuffer(), contentType);
}

function withRank<T extends object>(
  rows: T[],
  limit: number,
): Array<{ rank: number } & T> {
  return rows
    .slice(0, limit)
    .map((row, index) => ({ rank: index + 1, ...row }));
}

function isDirectoryLink(row: ArchiveLink): boolean {
  return (
    row.kind === "directory" &&
    !/^(?:search|update|pdf|whoweare)\//.test(row.path)
  );
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/g, "");
}

function scoreText(query: string, fields: Array<[string, number]>): number {
  const q = normalizeSearchText(query);
  if (!q) return 0;
  let score = 0;
  for (const [field, weight] of fields) {
    const normalized = normalizeSearchText(field);
    if (!normalized) continue;
    if (normalized === q) score += weight * 2;
    if (normalized.includes(q)) score += weight;
    for (const token of query.split(/\s+/).filter(Boolean)) {
      if (
        normalizeSearchText(token) !== q &&
        normalized.includes(normalizeSearchText(token))
      ) {
        score += Math.max(1, Math.round(weight / 3));
      }
    }
  }
  return score;
}

function snippetFor(text: string, query: string, maxLength = 220): string {
  const normalized = normalizeSearchText(text);
  const q = normalizeSearchText(query);
  const normalizedIndex = normalized.indexOf(q);
  if (normalizedIndex < 0) return text.slice(0, maxLength).trim();
  const rawIndex = Math.max(0, Math.min(text.length, normalizedIndex));
  const start = Math.max(0, rawIndex - 80);
  const end = Math.min(text.length, rawIndex + maxLength - 80);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

async function fetchWorksForScope(scope: string): Promise<WorkLink[]> {
  const path = normalizeMarxistsPath(scope, { directoryIndex: true });
  return parseMarxistsWorks(
    await fetchArchiveHtml(path),
    path,
    marxistsUrl(path),
  );
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function buildSearchCandidates(options: {
  query: string;
  scope: string;
  scanPages: number;
  fullText: boolean;
  contentPages: number;
}): Promise<SearchCandidate[]> {
  const candidates: SearchCandidate[] = [];
  const indexRows = parseMarxistsIndex(
    await fetchArchiveHtml("index.html"),
    MARXISTS_CN_BASE,
  );

  for (const row of indexRows) {
    const score = scoreText(options.query, [
      [row.title, 40],
      [row.latinName, 24],
      [row.path, 8],
    ]);
    if (score > 0) {
      candidates.push({
        type: row.kind === "directory" ? "person_or_topic" : row.kind,
        scope: row.path,
        section: "",
        title: row.title,
        snippet: row.latinName,
        path: row.path,
        url: row.url,
        score,
      });
    }
  }

  const scopes = options.scope
    ? [normalizeMarxistsPath(options.scope, { directoryIndex: true })]
    : indexRows
        .filter(isDirectoryLink)
        .slice(0, options.scanPages)
        .map((row) => row.path);

  const workGroups = await mapLimit(scopes, 4, async (scope) => {
    try {
      return await fetchWorksForScope(scope);
    } catch {
      return [] as WorkLink[];
    }
  });

  const works = workGroups.flat();
  for (const work of works) {
    const score = scoreText(options.query, [
      [work.title, 50],
      [work.note, 18],
      [work.section, 10],
      [work.scope, 8],
      [work.path, 8],
    ]);
    if (score > 0) {
      candidates.push({
        type:
          work.format === "htm" || work.format === "html"
            ? "work"
            : work.format,
        scope: work.scope,
        section: work.section,
        title: work.title,
        snippet: work.note,
        path: work.path,
        url: work.url,
        score,
      });
    }
  }

  if (options.fullText) {
    const htmlWorks = works
      .filter((work) => /html?/i.test(work.format))
      .slice(0, options.contentPages);
    const textMatches = await mapLimit(htmlWorks, 3, async (work) => {
      try {
        const html = await fetchArchiveHtml(work.path);
        const text = marxistsHtmlToText(html);
        const score = scoreText(options.query, [[text, 80]]);
        if (score <= 0) return null;
        return {
          type: "text",
          scope: work.scope,
          section: work.section,
          title: work.title,
          snippet: snippetFor(text, options.query),
          path: work.path,
          url: work.url,
          score: score + 10,
        } satisfies SearchCandidate;
      } catch {
        return null;
      }
    });
    candidates.push(
      ...textMatches.filter((row): row is SearchCandidate => row !== null),
    );
  }

  const bestByTarget = new Map<string, SearchCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.type}:${candidate.path}:${candidate.title}`;
    const existing = bestByTarget.get(key);
    if (!existing || candidate.score > existing.score) {
      bestByTarget.set(key, candidate);
    }
  }

  return Array.from(bestByTarget.values()).sort(
    (a, b) => b.score - a.score || a.title.localeCompare(b.title),
  );
}

function assertHtmlReadablePath(path: string): void {
  const format = fileFormat(path);
  if (!["htm", "html", "txt"].includes(format)) {
    throw new Error(
      `marxists-cn read supports HTML/text paths only; "${path}" is ${format}.`,
    );
  }
}

export function marxistsReadingListRows(preset: string): ReadingListItem[] {
  const normalizedPreset = preset.trim().toLowerCase();
  if (normalizedPreset !== WESTERN_MARXISM_PRESET) {
    throw new Error(
      `marxists-cn reading-list preset must be ${WESTERN_MARXISM_PRESET}.`,
    );
  }
  return WESTERN_MARXISM_READINGS.map((row) => ({
    preset: WESTERN_MARXISM_PRESET,
    ...row,
    url: marxistsUrl(row.path),
    readCommand: `unicli marxists-cn read ${row.path}`,
  }));
}

cli({
  site: "marxists-cn",
  name: "index",
  description:
    "List Chinese Marxists Internet Archive top-level people, topics, and library links",
  domain: MARXISTS_HOST,
  base: MARXISTS_CN_BASE,
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 80, description: "Max rows" }],
  columns: INDEX_COLUMNS,
  capabilities: ["http.fetch", "archive.index", "marxism.reference"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) => {
    const limit = requireMarxistsLimit(kwargs.limit, 80, 300, "limit");
    return withRank(
      parseMarxistsIndex(await fetchArchiveHtml("index.html")),
      limit,
    );
  },
});

cli({
  site: "marxists-cn",
  name: "reading-list",
  description:
    "Return curated Chinese Marxists archive reading lists with directly readable paths",
  domain: MARXISTS_HOST,
  base: MARXISTS_CN_BASE,
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "preset",
      type: "str",
      required: true,
      positional: true,
      description: "Reading list preset, currently western-marxism",
    },
    { name: "limit", type: "int", default: 40, description: "Max rows" },
  ],
  columns: READING_LIST_COLUMNS,
  capabilities: [
    "archive.reading-list",
    "archive.read",
    "marxism.reference",
    "western-marxism.reference",
  ],
  minimum_capability: "archive.reading-list",
  func: async (_page, kwargs) => {
    const limit = requireMarxistsLimit(kwargs.limit, 40, 100, "limit");
    const preset = stringField(kwargs.preset);
    if (!preset)
      throw new Error("marxists-cn reading-list preset is required.");
    return withRank(marxistsReadingListRows(preset), limit);
  },
});

cli({
  site: "marxists-cn",
  name: "western-marxism",
  description:
    "List famous Western Marxist authors and works from the Chinese Marxists archive with read commands",
  domain: MARXISTS_HOST,
  base: MARXISTS_CN_BASE,
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 40, description: "Max rows" }],
  columns: READING_LIST_COLUMNS,
  capabilities: [
    "archive.reading-list",
    "archive.read",
    "marxism.reference",
    "western-marxism.reference",
  ],
  minimum_capability: "archive.reading-list",
  func: async (_page, kwargs) => {
    const limit = requireMarxistsLimit(kwargs.limit, 40, 100, "limit");
    return withRank(marxistsReadingListRows(WESTERN_MARXISM_PRESET), limit);
  },
});

cli({
  site: "marxists-cn",
  name: "authors",
  description:
    "List people, authors, organizations, and topic directories in the Chinese Marxists archive",
  domain: MARXISTS_HOST,
  base: MARXISTS_CN_BASE,
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 120, description: "Max rows" }],
  columns: INDEX_COLUMNS,
  capabilities: ["http.fetch", "archive.people", "marxism.reference"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) => {
    const limit = requireMarxistsLimit(kwargs.limit, 120, 300, "limit");
    const rows = parseMarxistsIndex(
      await fetchArchiveHtml("index.html"),
    ).filter(isDirectoryLink);
    return withRank(rows, limit);
  },
});

cli({
  site: "marxists-cn",
  name: "works",
  description:
    "List works/books/articles under a Chinese Marxists archive author or topic path",
  domain: MARXISTS_HOST,
  base: MARXISTS_CN_BASE,
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "scope",
      type: "str",
      required: true,
      positional: true,
      description: "Author/topic path, e.g. marx, lenin, georg-lukacs",
    },
    { name: "limit", type: "int", default: 120, description: "Max rows" },
  ],
  columns: WORK_COLUMNS,
  capabilities: ["http.fetch", "archive.works", "marxism.reference"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) => {
    const limit = requireMarxistsLimit(kwargs.limit, 120, 400, "limit");
    return withRank(await fetchWorksForScope(kwargs.scope as string), limit);
  },
});

cli({
  site: "marxists-cn",
  name: "read",
  description: "Read a Chinese Marxists archive HTML page as clean plain text",
  domain: MARXISTS_HOST,
  base: MARXISTS_CN_BASE,
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "path",
      type: "str",
      required: true,
      positional: true,
      description: "Archive path or URL under /chinese/",
    },
    {
      name: "max-length",
      type: "int",
      default: 30000,
      description: "Max text characters",
    },
  ],
  columns: READ_COLUMNS,
  capabilities: ["http.fetch", "archive.read", "marxism.reference"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) => {
    const path = normalizeMarxistsPath(kwargs.path);
    assertHtmlReadablePath(path);
    const maxLength = requireMarxistsLimit(
      kwargs["max-length"] ?? kwargs.maxLength,
      30000,
      200000,
      "max-length",
    );
    const url = marxistsUrl(path);
    return [mapMarxistsReadRow(await fetchArchiveHtml(path), url, maxLength)];
  },
});

cli({
  site: "marxists-cn",
  name: "search",
  description:
    "Search Chinese Marxists archive people, books, works, and scoped full text",
  domain: MARXISTS_HOST,
  base: MARXISTS_CN_BASE,
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Chinese or English search text",
    },
    { name: "limit", type: "int", default: 20, description: "Max rows" },
    {
      name: "scope",
      type: "str",
      default: "",
      description: "Optional author/topic path for focused search, e.g. marx",
    },
    {
      name: "scan-pages",
      type: "int",
      default: 24,
      description: "Top-level index pages to scan when scope is omitted",
    },
    {
      name: "full-text",
      type: "bool",
      default: false,
      description: "When true, search text inside scoped HTML work pages",
    },
    {
      name: "content-pages",
      type: "int",
      default: 40,
      description: "Max HTML pages to read for full-text scoped search",
    },
  ],
  columns: SEARCH_COLUMNS,
  capabilities: [
    "http.fetch",
    "archive.search",
    "archive.read",
    "marxism.reference",
  ],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) => {
    const query = stringField(kwargs.query);
    if (!query) throw new Error("marxists-cn search query cannot be empty.");
    const limit = requireMarxistsLimit(kwargs.limit, 20, 100, "limit");
    const scanPages = requireMarxistsLimit(
      kwargs["scan-pages"] ?? kwargs.scanPages,
      24,
      120,
      "scan-pages",
    );
    const contentPages = requireMarxistsLimit(
      kwargs["content-pages"] ?? kwargs.contentPages,
      40,
      120,
      "content-pages",
    );
    const scope = stringField(kwargs.scope);
    const fullText = boolArg(kwargs["full-text"] ?? kwargs.fullText);
    if (fullText && !scope) {
      throw new Error(
        "marxists-cn full-text search requires --scope to bound the crawl.",
      );
    }
    return withRank(
      await buildSearchCandidates({
        query,
        scope,
        scanPages,
        fullText,
        contentPages,
      }),
      limit,
    );
  },
});
