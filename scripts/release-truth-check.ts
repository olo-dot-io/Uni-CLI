/**
 * @owner       scripts::release-truth-check
 * @does        Cross-checks release-facing runtime, workflow, dependency, privacy, and security claims against executable repository state.
 * @needs       package.json, CI/release workflows, updater constant, PRIVACY.md, SECURITY.md
 * @feeds       npm run truth:check, CI, release verification
 * @breaks      Any missing Node/audit gate, wrong scoped URL, or resurrected false security claim fails non-zero.
 * @invariants  Checks derive package identity and dependency count from package.json rather than copying them into docs.
 * @side-effects Reads repository files and writes one summary line.
 * @test        Executed by npm run verify and both publish/mainline workflow gates.
 * @stability   stable
 * @since       2026-07-12
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { UPDATE_REGISTRY_URL } from "../src/engine/update-check.js";

interface WorkflowStep {
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
}

interface WorkflowJob {
  strategy?: { matrix?: { include?: Array<Record<string, unknown>> } };
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

interface PackageManifest {
  name: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function fail(message: string): never {
  throw new Error(`release-truth-check: ${message}`);
}

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

function workflow(path: string): Workflow {
  return parse(read(path)) as Workflow;
}

function allSteps(value: Workflow): WorkflowStep[] {
  return Object.values(value.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function hasRun(steps: WorkflowStep[], command: string): boolean {
  return steps.some((step) => step.run?.includes(command));
}

const manifest = JSON.parse(read("package.json")) as PackageManifest;
const ci = workflow(".github/workflows/ci.yml");
const release = workflow(".github/workflows/release.yml");
const privacy = read("PRIVACY.md");
const security = read("SECURITY.md");

if (manifest.engines?.node !== ">=22.19.0") {
  fail(
    `unexpected Node support contract: ${manifest.engines?.node ?? "missing"}`,
  );
}

const verifyMatrix = ci.jobs?.verify?.strategy?.matrix?.include ?? [];
for (const major of [22, 24]) {
  if (!verifyMatrix.some((entry) => Number(entry["node-version"]) === major)) {
    fail(`CI verify matrix does not exercise supported Node ${major}`);
  }
}

const auditCommand = "npm audit --omit=dev --audit-level=moderate";
if (!hasRun(allSteps(ci), auditCommand)) {
  fail("CI does not gate production dependency advisories");
}
if (!hasRun(allSteps(release), auditCommand)) {
  fail("release workflow does not re-run the production dependency audit");
}

const verifySteps = ci.jobs?.verify?.steps ?? [];
const unitStep = verifySteps.find((step) => step.run === "npm run test");
if (!unitStep?.if?.includes("node-compat")) {
  fail("Node 24 compatibility matrix does not execute the unit suite");
}

const benchmarkSteps = ci.jobs?.["benchmark-evidence"]?.steps ?? [];
const benchmarkStep = benchmarkSteps.find(
  (step) => step.run === "npm run bench",
);
if (benchmarkStep?.env?.BENCH_FIXTURES_ONLY !== "1") {
  fail("scheduled benchmark evidence is not pinned to fixture mode");
}

const expectedRegistryUrl = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/latest`;
if (UPDATE_REGISTRY_URL !== expectedRegistryUrl) {
  fail(
    `updater endpoint ${UPDATE_REGISTRY_URL} does not match scoped package ${expectedRegistryUrl}`,
  );
}

if (!manifest.scripts?.verify?.includes("npm run truth:check")) {
  fail("npm run verify does not include the release truth gate");
}

const requiredPrivacyClaims: Array<[RegExp, string]> = [
  [/do\s+\*\*not\*\*\s+persist/i, "live acquisition does not persist"],
  [/unencrypted JSON object/i, "explicit storage is unencrypted JSON"],
  [/mode\s+`0700`/i, "POSIX directory mode 0700"],
  [/mode\s+`0600`/i, "POSIX file mode 0600"],
];
for (const [pattern, claim] of requiredPrivacyClaims) {
  if (!pattern.test(privacy)) fail(`PRIVACY.md is missing: ${claim}`);
}

const requiredSecurityClaims: Array<[RegExp, string]> = [
  [/do not write cookies to disk/i, "runtime refresh does not persist"],
  [/store unencrypted JSON/i, "explicit storage is unencrypted JSON"],
  [/directory is\s+`0700`/i, "POSIX directory mode 0700"],
  [/files are\s+`0600`/i, "POSIX file mode 0600"],
];
for (const [pattern, claim] of requiredSecurityClaims) {
  if (!pattern.test(security)) fail(`SECURITY.md is missing: ${claim}`);
}

const retiredClaims = [
  /cookies stay in chrome/i,
  /cookies are never extracted/i,
  /no credentials (?:are )?stored on disk/i,
  /(?:only|exactly)\s+\d+\s+(?:direct\s+)?runtime dependencies/i,
];
for (const pattern of retiredClaims) {
  if (pattern.test(`${privacy}\n${security}`)) {
    fail(`retired security claim reappeared: ${pattern.source}`);
  }
}

const dependencyCount = Object.keys(manifest.dependencies ?? {}).length;
process.stdout.write(
  `release-truth-check: PASS — Node 22/24, scoped updater, audit gates, ${dependencyCount} direct runtime dependencies, and credential claims agree\n`,
);
