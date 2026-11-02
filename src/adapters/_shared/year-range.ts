/**
 * @owner       src::adapters::_shared::year-range
 * @does        Parses a publication year or inclusive year range for scholarly source searches.
 * @feeds       scholar search and the search commands of its sources, which push the range into each API.
 * @invariants  Accepts YYYY or YYYY-YYYY (also YYYY..YYYY) within [1800, 2100], running forward.
 */

export interface YearRange {
  from: number;
  to: number;
}

export const YEAR_RANGE_ARG = {
  name: "year",
  type: "str",
  description: "publication year or inclusive range, such as 2026 or 2024-2026",
} as const;

export function parseYearRange(value: unknown): YearRange | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const match = String(value)
    .trim()
    .match(/^(\d{4})(?:\s*(?:-|\.\.)\s*(\d{4}))?$/);
  const from = Number(match?.[1]);
  const to = Number(match?.[2] ?? match?.[1]);
  if (!match || from < 1800 || to > 2100 || to < from) {
    throw new Error(
      "year must be YYYY or a forward range YYYY-YYYY within [1800, 2100].",
    );
  }
  return { from, to };
}
