/**
 * @owner   src/engine/verify-row-shape.ts
 * @does    Detect "silent column drops" — adapter declares columns the data never populates.
 * @needs   none
 * @feeds   src/cli.ts (unicli test post-run check), src/commands/lint.ts (future audit gate)
 * @breaks  A column declared in YAML but absent in every row is a contract violation; surface as a structured warning. Treats `false`/`0`/`[]`/`{}` as POPULATED (formatter renders them as visible values); only `undefined`, `null`, and the empty string "" count as drops.
 */

export interface RowShapeReport {
  /** declared columns the data never populated with a non-null value */
  dropped: string[];
  /** declared columns at least one row populated */
  populated: string[];
  /** true when results are non-array, items are non-object, or no columns declared */
  skipped: boolean;
}

const EMPTY: RowShapeReport = { dropped: [], populated: [], skipped: true };

export function verifyRowShape(
  results: unknown,
  declaredColumns: readonly string[] | undefined,
): RowShapeReport {
  if (!declaredColumns || declaredColumns.length === 0) return EMPTY;
  if (!Array.isArray(results) || results.length === 0) return EMPTY;

  const dropped: string[] = [];
  const populated: string[] = [];

  for (const col of declaredColumns) {
    let seen = false;
    for (const row of results) {
      if (row == null || typeof row !== "object" || Array.isArray(row))
        continue;
      const value = (row as Record<string, unknown>)[col];
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.length === 0) continue;
      seen = true;
      break;
    }
    if (seen) populated.push(col);
    else dropped.push(col);
  }

  return { dropped, populated, skipped: false };
}
