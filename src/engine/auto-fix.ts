/**
 * Auto-Fix Level 1 — detect broken select paths and suggest alternatives.
 *
 * When a select step fails with selector_miss, this module analyzes the
 * actual data structure to find array fields that might be the correct path.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Apply a select path fix to a user adapter YAML file.
 * Writes to ~/.unicli/adapters/<site>/<cmd>.yaml (user override dir).
 */
export function applySelectFix(
  site: string,
  command: string,
  _stepIndex: number,
  oldPath: string,
  newPath: string,
  adapterPath?: string,
): string | null {
  try {
    // Validate site/command names
    if (!/^[a-zA-Z0-9._-]+$/.test(site)) return null;
    if (!/^[a-zA-Z0-9._-]+$/.test(command)) return null;

    let content: string | undefined;
    if (adapterPath) {
      try {
        content = readFileSync(adapterPath, "utf-8");
      } catch {
        // Can't read source adapter
      }
    }

    // Write fix to user adapter dir
    const userDir = join(
      process.env.HOME ?? "~",
      ".unicli",
      "adapters",
      site,
    );
    mkdirSync(userDir, { recursive: true });
    const userPath = join(userDir, `${command}.yaml`);

    if (content) {
      // Simple string replacement of the select path
      const fixed = content.replace(
        new RegExp(`(select:\\s*)(['"]?)${oldPath.replace(/\./g, "\\.")}\\2`),
        `$1$2${newPath}$2`,
      );
      writeFileSync(userPath, fixed, "utf-8");
    }

    return userPath;
  } catch {
    return null;
  }
}
