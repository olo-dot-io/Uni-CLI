/**
 * Auto-Fix Level 1 — detect broken select paths and suggest alternatives.
 *
 * When a select step fails with selector_miss, this module analyzes the
 * actual data structure to find array fields that might be the correct path.
 */

/**
 * Analyze data structure and suggest alternative select paths.
 * Finds all array-valued paths in the object tree (max depth 5).
 */
export function suggestSelectFix(data: unknown, failedPath: string): string[] {
  if (!data || typeof data !== "object") return [];

  const paths: string[] = [];
  findArrayPaths(data as Record<string, unknown>, "", paths, 0);
  return paths.filter((p) => p !== failedPath);
}

function findArrayPaths(
  obj: Record<string, unknown>,
  prefix: string,
  paths: string[],
  depth: number,
): void {
  if (depth > 5) return;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      paths.push(path);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      findArrayPaths(value as Record<string, unknown>, path, paths, depth + 1);
    }
  }
}
