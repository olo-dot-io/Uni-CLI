const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "...",
  ldquo: '"',
  lsquo: "'",
  lt: "<",
  mdash: "-",
  nbsp: " ",
  ndash: "-",
  quot: '"',
  rdquo: '"',
  rsquo: "'",
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
