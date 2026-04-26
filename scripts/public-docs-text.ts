const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/u;
const cjkAndPunctuationPattern =
  /[\u3400-\u9fff\uf900-\ufaff。！？；，、：“”‘’《》【】]+/gu;
const parentheticalPattern = /\(([^()]*)\)/g;
const edgeSeparatorPattern = /^[\s,;:，、；：/|·-]+|[\s,;:，、；：/|·-]+$/gu;

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimEdgeSeparators(value: string): string {
  return normalizeSpaces(value.replace(edgeSeparatorPattern, ""));
}

function stripCjkFromSegment(value: string): string {
  return trimEdgeSeparators(
    value.replace(cjkAndPunctuationPattern, " ").replace(/\s+/g, " "),
  );
}

export function publicEnglishDescription(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = normalizeSpaces((value ?? "").normalize("NFKC"));

  if (!normalized) {
    return fallback;
  }

  const withCleanParentheticals = normalizeSpaces(
    normalized.replace(parentheticalPattern, (_match, inner: string) => {
      const cleanedInner = stripCjkFromSegment(inner);
      return cleanedInner ? ` (${cleanedInner}) ` : " ";
    }),
  );

  if (!cjkPattern.test(withCleanParentheticals)) {
    return withCleanParentheticals || fallback;
  }

  const cjkIndex = withCleanParentheticals.search(cjkPattern);
  const candidate = trimEdgeSeparators(
    withCleanParentheticals.slice(0, cjkIndex),
  );

  return candidate && !cjkPattern.test(candidate) ? candidate : fallback;
}
