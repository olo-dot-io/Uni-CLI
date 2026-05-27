/**
 * @owner   src/engine/text-normalize.ts
 * @does    Normalize HTML/XML text fragments into plain agent-readable strings.
 * @needs   Small built-in HTML entity table, Unicode code point decoding.
 * @feeds   adapter text extraction, XML/RSS normalization, social video text cleanup.
 * @breaks  Missing named entities leak HTML escapes into adapter output.
 * @invariants Numeric entities always decode through String.fromCodePoint; unknown named entities remain visible.
 * @side-effects none
 * @perf    Linear in input length with at most four nested entity decode passes.
 * @concurrency pure functions only
 * @test    src/adapters/marxists-cn/archive.test.ts
 * @stability stable
 * @since   0.224.0
 */

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  Aacute: "Á",
  aacute: "á",
  Acirc: "Â",
  acirc: "â",
  Agrave: "À",
  agrave: "à",
  Aring: "Å",
  aring: "å",
  Auml: "Ä",
  auml: "ä",
  bull: "•",
  Ccedil: "Ç",
  ccedil: "ç",
  Eacute: "É",
  eacute: "é",
  Ecirc: "Ê",
  ecirc: "ê",
  Egrave: "È",
  egrave: "è",
  Euml: "Ë",
  euml: "ë",
  gt: ">",
  hellip: "...",
  Iacute: "Í",
  iacute: "í",
  Icirc: "Î",
  icirc: "î",
  Igrave: "Ì",
  igrave: "ì",
  Iuml: "Ï",
  iuml: "ï",
  ldquo: '"',
  lsquo: "'",
  lt: "<",
  mdash: "-",
  middot: "·",
  nbsp: " ",
  ndash: "-",
  Ntilde: "Ñ",
  ntilde: "ñ",
  Oacute: "Ó",
  oacute: "ó",
  Ocirc: "Ô",
  ocirc: "ô",
  Ograve: "Ò",
  ograve: "ò",
  Oslash: "Ø",
  oslash: "ø",
  Ouml: "Ö",
  ouml: "ö",
  quot: '"',
  rdquo: '"',
  rsquo: "'",
  Uacute: "Ú",
  uacute: "ú",
  Ucirc: "Û",
  ucirc: "û",
  Ugrave: "Ù",
  ugrave: "ù",
  Uuml: "Ü",
  uuml: "ü",
};

function decodeEntity(entity: string): string | null {
  const fromCodePoint = (codePoint: number): string | null => {
    if (!Number.isFinite(codePoint)) return null;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return null;
    }
  };
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    const codePoint = Number.parseInt(entity.slice(2), 16);
    return fromCodePoint(codePoint);
  }
  if (entity.startsWith("#")) {
    const codePoint = Number.parseInt(entity.slice(1), 10);
    return fromCodePoint(codePoint);
  }
  return HTML_ENTITIES[entity] ?? null;
}

export function decodeHtmlEntities(value: string): string {
  let current = value;
  for (let i = 0; i < 4; i += 1) {
    const next = current.replace(
      /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g,
      (match, entity: string) => decodeEntity(entity) ?? match,
    );
    if (next === current) break;
    current = next;
  }
  return current.replace(/\u00a0/g, " ");
}

export function stripCdata(value: string): string {
  const trimmed = value.trim();
  const cdata = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return cdata ? cdata[1] : trimmed;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeXmlText(value: string): string {
  return normalizeWhitespace(decodeHtmlEntities(stripCdata(value)));
}

export function stripHtml(value: string): string {
  return normalizeWhitespace(decodeHtmlEntities(value).replace(/<[^>]+>/g, " "))
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}
