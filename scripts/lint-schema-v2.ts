#!/usr/bin/env node
/**
 * schema-v2 lint — fail-fast gate for `npm run verify`.
 *
 * Walks `src/adapters/**\/*.yaml` and asserts every file carries the six
 * schema-v2 metadata fields with correct shape:
 *
 *   schema_version     — literal "v2"
 *   capabilities       — string[]
 *   minimum_capability — non-empty string
 *   trust              — "public" | "user" | "system"
 *   confidentiality    — "public" | "internal" | "private"
 *   quarantine         — boolean
 *
 * Exits 1 with a newline-delimited list of offending files on failure,
 * 0 on pass. Prefers loud-and-fast output over long explanations — CI
 * surfaces the paths; `unicli migrate schema-v2 --write` fixes them.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseAdapterV2 } from "../src/core/schema-v2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ADAPTERS_DIR = join(ROOT, "src", "adapters");

function* walkYaml(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    if (extname(path) === ".yaml" || extname(path) === ".yml") yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    yield* walkYaml(join(path, entry));
  }
}

interface Failure {
  file: string;
  reason: string;
}

function lintFile(abs: string): Failure | null {
  const rel = relative(ROOT, abs);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf-8");
  } catch (err) {
    return { file: rel, reason: `read failed: ${stringifyErr(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return { file: rel, reason: `yaml parse failed: ${stringifyErr(err)}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { file: rel, reason: "top-level YAML is not an object" };
  }

  const record = parsed as Record<string, unknown>;

  // Missing `schema_version` is treated as a hard fail. Every post-migration
  // YAML must carry the tag explicitly — the lint is the gate that keeps
  // new adapters from regressing.
  if (record.schema_version !== "v2") {
    return {
      file: rel,
      reason: `schema_version must be "v2" (got ${JSON.stringify(record.schema_version)})`,
    };
  }

  // Feed through the zod schema for shape + enum checks. Inject the
  // filename-derived name when the YAML omits `name`, matching what the
  // runtime loader does.
  const projection = {
    name: typeof record.name === "string" ? record.name : rel,
    description: record.description,
    schema_version: record.schema_version,
    capabilities: record.capabilities,
    minimum_capability: record.minimum_capability,
    trust: record.trust,
    confidentiality: record.confidentiality,
    quarantine: record.quarantine ?? false,
  };

  try {
    parseAdapterV2(projection);
  } catch (err) {
    return { file: rel, reason: `schema-v2 invalid: ${stringifyErr(err)}` };
  }

  return null;
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0];
  return String(err);
}

function main(): void {
  const files = Array.from(walkYaml(ADAPTERS_DIR));
  const failures: Failure[] = [];

  for (const abs of files) {
    const failure = lintFile(abs);
    if (failure) failures.push(failure);
  }

  if (failures.length > 0) {
    process.stderr.write(
      `schema-v2 lint: ${failures.length} of ${files.length} adapters failed\n`,
    );
    for (const f of failures) {
      process.stderr.write(`  ${f.file}: ${f.reason}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`schema-v2 lint: ${files.length} adapters conform\n`);
}

main();
