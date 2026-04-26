import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userHome } from "../engine/user-home.js";

export type FixtureExpect = {
  rowCount?: { min?: number; max?: number };
  columns?: string[];
  types?: Record<string, string>;
  patterns?: Record<string, string>;
  notEmpty?: string[];
  mustNotContain?: Record<string, string[]>;
  mustBeTruthy?: string[];
};

export type FixtureArgs = Record<string, unknown> | unknown[];

export type Fixture = {
  args?: FixtureArgs;
  expect?: FixtureExpect;
};

export type Row = Record<string, unknown>;

export type ValidationFailure = {
  rule:
    | "rowCount"
    | "column"
    | "type"
    | "pattern"
    | "notEmpty"
    | "mustNotContain"
    | "mustBeTruthy";
  detail: string;
  rowIndex?: number;
};

export function fixturePath(
  site: string,
  command: string,
  baseDir = userHome(),
): string {
  return join(baseDir, ".unicli", "sites", site, "verify", `${command}.json`);
}

export function loadFixture(
  site: string,
  command: string,
  baseDir?: string,
): Fixture | null {
  const path = fixturePath(site, command, baseDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Fixture;
}

export function writeFixture(
  site: string,
  command: string,
  fixture: Fixture,
  baseDir?: string,
): string {
  const path = fixturePath(site, command, baseDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n", "utf-8");
  return path;
}

function jsType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function deriveFixture(rows: Row[], args?: FixtureArgs): Fixture {
  const expect: FixtureExpect = {};
  if (rows.length === 0) {
    expect.rowCount = { min: 0 };
    return { ...(args ? { args } : {}), expect };
  }

  expect.rowCount = { min: 1 };
  expect.columns = Object.keys(rows[0]);
  const types: Record<string, string> = {};
  for (const column of expect.columns) {
    const observed = new Set<string>();
    for (const row of rows) observed.add(jsType(row[column]));
    types[column] = Array.from(observed).sort().join("|");
  }
  expect.types = types;
  return { ...(args ? { args } : {}), expect };
}

function typeMatches(actual: string, declared: string): boolean {
  const allowed = declared
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    allowed.length === 0 || allowed.includes("any") || allowed.includes(actual)
  );
}

export function validateRows(
  rows: Row[],
  fixture: Fixture,
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  const expect = fixture.expect;
  if (!expect) return failures;

  if (expect.rowCount) {
    const { min, max } = expect.rowCount;
    if (typeof min === "number" && rows.length < min) {
      failures.push({
        rule: "rowCount",
        detail: `got ${rows.length} rows, expected at least ${min}`,
      });
    }
    if (typeof max === "number" && rows.length > max) {
      failures.push({
        rule: "rowCount",
        detail: `got ${rows.length} rows, expected at most ${max}`,
      });
    }
  }

  const compiledPatterns: Record<string, RegExp> = {};
  for (const [column, pattern] of Object.entries(expect.patterns ?? {})) {
    try {
      compiledPatterns[column] = new RegExp(pattern);
    } catch (err) {
      failures.push({
        rule: "pattern",
        detail: `pattern for "${column}" invalid: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  rows.forEach((row, rowIndex) => {
    for (const column of expect.columns ?? []) {
      if (!(column in row)) {
        failures.push({
          rule: "column",
          detail: `missing column "${column}"`,
          rowIndex,
        });
      }
    }
    for (const [column, declared] of Object.entries(expect.types ?? {})) {
      if (!(column in row)) continue;
      const actual = jsType(row[column]);
      if (!typeMatches(actual, declared)) {
        failures.push({
          rule: "type",
          detail: `"${column}" is ${actual}, expected ${declared}`,
          rowIndex,
        });
      }
    }
    for (const [column, pattern] of Object.entries(compiledPatterns)) {
      if (!(column in row)) continue;
      const value = row[column];
      if (value === null || value === undefined) continue;
      if (!pattern.test(String(value))) {
        failures.push({
          rule: "pattern",
          detail: `"${column}" does not match /${pattern.source}/`,
          rowIndex,
        });
      }
    }
    for (const column of expect.notEmpty ?? []) {
      const value = row[column];
      if (
        value === null ||
        value === undefined ||
        String(value).trim() === ""
      ) {
        failures.push({
          rule: "notEmpty",
          detail: `"${column}" is empty`,
          rowIndex,
        });
      }
    }
    for (const [column, needles] of Object.entries(
      expect.mustNotContain ?? {},
    )) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      for (const needle of needles) {
        if (String(value).includes(needle)) {
          failures.push({
            rule: "mustNotContain",
            detail: `"${column}" contains forbidden substring ${JSON.stringify(needle)}`,
            rowIndex,
          });
        }
      }
    }
    for (const column of expect.mustBeTruthy ?? []) {
      if (!row[column]) {
        failures.push({
          rule: "mustBeTruthy",
          detail: `"${column}" is falsy (${JSON.stringify(row[column])})`,
          rowIndex,
        });
      }
    }
  });

  return failures;
}

export function expandFixtureArgs(args: FixtureArgs | undefined): string[] {
  if (!args) return [];
  if (Array.isArray(args)) return args.map((value) => String(value));
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    out.push(`--${key}`, String(value));
  }
  return out;
}
