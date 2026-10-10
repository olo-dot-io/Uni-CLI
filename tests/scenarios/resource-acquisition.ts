import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  EvidenceCandidate,
  ResourceAcquisition,
} from "../../src/engine/retrieval.js";

const home = await mkdtemp(join(tmpdir(), "unicli-resource-scenario-"));
process.env.HOME = home;
process.env.UNICLI_ALLOW_LOCAL = "1";
process.env.UNICLI_NO_LOG = "1";
process.env.UNICLI_COOKIE_DIR = join(home, "cookies");
process.env.UNICLI_COOKIE_NO_BROWSER = "1";
const { cli, Strategy } = await import("../../src/registry.js");
const { buildInvocation, execute } =
  await import("../../src/engine/kernel/execute.js");
const { acquireEvidenceResources } =
  await import("../../src/engine/retrieval.js");
const { httpDownload, mapConcurrent } =
  await import("../../src/engine/download.js");
const { stepDownload } = await import("../../src/engine/steps/download.js");
const { saveCookies } = await import("../../src/engine/cookie-storage.js");
const { withCredentialRecovery } =
  await import("../../src/engine/request-credentials.js");
const { primeKernelCache } = await import("../../src/discovery/loader.js");
await import("../../src/adapters/retrieval/intelligence.js");

const outcomes: Array<{ scenario: string; passed: boolean; detail?: unknown }> =
  [];
const hits = new Map<string, number>();
const requestTimes = new Map<string, number[]>();
let activeDownloads = 0;
let peakDownloads = 0;
let revision = 1;
let failDataset = true;
let slowResources = true;
let failRoot = true;
let validJson = false;
let base = "";
let sourceReads = 0;
let foreignCookie = false;
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  hits.set(path, (hits.get(path) ?? 0) + 1);
  requestTimes.set(path, [
    ...(requestTimes.get(path) ?? []),
    performance.now(),
  ]);
  activeDownloads++;
  peakDownloads = Math.max(peakDownloads, activeDownloads);
  response.on("close", () => activeDownloads--);
  if (path.startsWith("/credential-")) {
    const expected =
      path === "/credential-start" ? "session=source" : "session=target";
    if (
      path === "/credential-target" &&
      request.headers.cookie === "session=source"
    )
      foreignCookie = true;
    if (request.headers.cookie !== expected) {
      response.writeHead(401);
      response.end("Authentication required");
    } else if (path === "/credential-start") {
      response.writeHead(302, {
        location: `${base.replace("127.0.0.1", "localhost")}/credential-target`,
      });
      response.end();
    } else {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end("%PDF-1.7\nAuthenticated resource");
    }
    return;
  }
  if (
    path === "/retry-cancel" ||
    (path.startsWith("/retry") && hits.get(path) === 1)
  ) {
    response.writeHead(path === "/retry503" ? 503 : 429, {
      "retry-after":
        path === "/retry-cancel"
          ? "2147484"
          : path === "/retry429"
            ? "1.05"
            : "0",
    });
    response.end("Retry after the upstream recovery window");
    return;
  }
  if (path === "/interrupted" && hits.get(path) === 1) {
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": "4096",
    });
    response.write("%PDF-partial");
    setTimeout(() => response.destroy(), 10);
    return;
  }
  if (path === "/slow.pdf" && slowResources) {
    response.writeHead(200, { "content-type": "application/pdf" });
    response.write("%PDF-1.7\n");
    const interval = setInterval(() => response.write("x".repeat(256)), 10);
    response.on("close", () => clearInterval(interval));
    return;
  }
  if (path === "/large-length") {
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": "4096",
    });
    response.end("x".repeat(4096));
    return;
  }
  if (path === "/large-stream") {
    response.writeHead(200, { "content-type": "application/pdf" });
    response.write("x".repeat(256));
    response.end("y".repeat(256));
    return;
  }
  if (path === "/challenge-header" || path === "/challenge-body") {
    response.writeHead(200, {
      "content-type": "text/html",
      ...(path.endsWith("header") ? { "cf-mitigated": "challenge" } : {}),
    });
    response.end(
      "<!doctype html><title>Making sure you&#39;re not a bot!</title><h1>Making sure you're not a bot!</h1><script id='anubis_challenge'>challenge</script>",
    );
    return;
  }
  setTimeout(() => {
    if (path === "/recover-page" && failRoot) {
      response.writeHead(503);
      response.end("Source page temporarily unavailable");
    } else if (path === "/recover-page") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<html><article><h1>Recovered source page</h1><p>Source page is available again.</p><a href="/recovered.pdf">Download recovered paper</a></article></html>',
      );
    } else if (path === "/library" || path === "/catalog") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const links =
        path === "/library"
          ? '<a href="/data.csv">Quartz dataset</a><a href="/a/paper.pdf">Quartz paper</a><a href="/unrelated.zip">Unrelated archive</a><a href="/next">Ordinary next page</a>'
          : '<a href="/data.csv#second">Quartz dataset duplicate</a><a href="/b/paper.pdf">Quartz supplement</a>';
      response.end(
        `<html><head><title>Quartz source ${revision}</title></head><body><article><h1>Quartz resources</h1><p>Revision ${revision}. Published datasets and paper resources are listed here. Keep **literal** text and structured source links.</p>${links}</article></body></html>`,
      );
    } else if (path === "/data.csv" && failDataset) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("Dataset temporarily unavailable");
    } else if (path === "/data.csv") {
      response.writeHead(200, { "content-type": "text/csv" });
      response.end("id,value\n1,quartz\n");
    } else if (path === "/invalid.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(validJson ? '{"result":"valid"}' : "{invalid");
    } else if (path === "/linked.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<html><article><h1>Download sample</h1><p>A downloadable HTML resource.</p><a href="/deep.pdf">Download deeper file</a></article></html>',
      );
    } else if (path === "/one-level") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<html><article><h1>Download index</h1><p>A selected source index.</p><a href="/linked.html">Download sample</a></article></html>',
      );
    } else {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(`%PDF-1.7\n${path}\nrevision ${revision}\n`);
    }
  }, 15);
});

function resultCandidate(
  url: string,
  raw: Record<string, unknown> = {},
): EvidenceCandidate {
  return {
    id: url,
    title: "Quartz resource",
    url,
    domain: "127.0.0.1",
    summary: "",
    result_kind: "docs",
    source_class: "official",
    source_adapter: "scenario-resource",
    source_command: "search",
    source_rank: 1,
    source_refs: ["scenario-resource/search"],
    published_at: "",
    updated_at: "",
    retrieved_at: new Date().toISOString(),
    rrf_score: 1,
    raw: { url, ...raw },
  };
}

async function acquire(args: Record<string, unknown>) {
  const invocation = buildInvocation(
    "cli",
    "retrieval",
    "acquire",
    {
      args: {
        query: "quartz",
        sources: "scenario-resource,scenario-resource-failure",
        ...args,
      },
      source: "internal",
    },
    { approved: true },
  );
  if (!invocation)
    throw new Error("Resource acquisition command was not registered");
  const result = await execute(invocation);
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.results[0] as ResourceAcquisition;
}

try {
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Scenario server did not bind");
  base = `http://127.0.0.1:${address.port}`;
  for (const site of ["scenario-resource", "scenario-resource-failure"]) {
    cli({
      site,
      name: "search",
      description: "Return controlled resource locations",
      strategy: Strategy.PUBLIC,
      browser: false,
      operation_effect: "read",
      capabilities: ["http.fetch"],
      minimum_capability: "http.fetch",
      args: [{ name: "query", type: "str", required: true }],
      retrieval: {
        operation: "discover",
        result_kind: "docs",
        source_class: "official",
        arguments: { query: "query" },
      },
      // REASON: Fixture source records define the external discovery boundary; downloads use a real HTTP server.
      func: async () => {
        sourceReads++;
        if (site.endsWith("failure"))
          throw Object.assign(new Error("Fixture source unavailable"), {
            code: "upstream_error",
          });
        return [
          { title: "Quartz library", url: `${base}/library` },
          { title: "Quartz duplicate", url: `${base}/library#duplicate` },
          { title: "Quartz catalog", url: `${base}/catalog` },
        ];
      },
    });
  }
  primeKernelCache();
  const directory = join(home, "batch");
  const first = await acquire({
    dir: directory,
    concurrency: 2,
    max_resources: 3,
  });
  outcomes.push({
    scenario:
      "search normalizes duplicate candidates and retains source failures",
    passed: first.candidates.length === 2 && first.source_errors.length === 1,
    detail: {
      candidates: first.candidates.length,
      errors: first.source_errors.length,
    },
  });
  outcomes.push({
    scenario: "one GET per selected page with structured content",
    passed:
      hits.get("/library") === 1 &&
      hits.get("/catalog") === 1 &&
      first.resources.filter((resource) => resource.document_path).length === 2,
    detail: first.resources.map((resource) => ({
      url: resource.url,
      document_path: resource.document_path,
    })),
  });
  const files = first.resources.filter((resource) =>
    resource.url.includes("paper.pdf"),
  );
  outcomes.push({
    scenario:
      "bounded ranked links deduplicate URLs and preserve distinct same-name files",
    passed:
      first.linked_resources_found === 4 &&
      first.linked_resources_selected === 3 &&
      first.resources.length === 5 &&
      files.length === 2 &&
      files[0].path !== files[1].path &&
      !hits.has("/unrelated.zip") &&
      !hits.has("/next") &&
      peakDownloads <= 2,
    detail: {
      found: first.linked_resources_found,
      selected: first.linked_resources_selected,
      peakDownloads,
    },
  });
  const failure = first.resources.find(
    (resource) => resource.url === `${base}/data.csv`,
  );
  outcomes.push({
    scenario: "download failure preserves exact resource and retry metadata",
    passed:
      failure?.status === "failed" &&
      failure.code === "http_error" &&
      failure.statusCode === 503 &&
      !!failure.retry_command &&
      failure.source_urls.length === 2,
    detail: failure,
  });
  const firstStored = JSON.parse(await readFile(first.manifest_path, "utf8"));
  outcomes.push({
    scenario: "published result data matches command output",
    passed: JSON.stringify(firstStored) === JSON.stringify(first),
  });

  failDataset = false;
  const second = await acquire({
    dir: directory,
    concurrency: 2,
    max_resources: 3,
  });
  outcomes.push({
    scenario: "rerun retries failures and reuses completed downloads",
    passed:
      second.resources.filter((resource) => resource.status === "skipped")
        .length === 4 &&
      second.resources.find((resource) => resource.url === `${base}/data.csv`)
        ?.status === "success" &&
      hits.get("/data.csv") === 3 &&
      hits.get("/library") === 1 &&
      hits.get("/a/paper.pdf") === 1,
    detail: second.resources.map((resource) => ({
      url: resource.url,
      status: resource.status,
    })),
  });
  const child = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { readFile } from 'node:fs/promises';
    import { acquireEvidenceResources } from './src/engine/retrieval.ts';
    const previous = JSON.parse(await readFile(process.argv[1], 'utf8'));
    const result = await acquireEvidenceResources('', [], { resume: process.argv[1] });
    process.stdout.write(JSON.stringify(result.resources.map(resource => resource.status)));
  `,
      second.manifest_path,
    ],
    { cwd: process.cwd(), env: process.env },
  );
  const restarted = JSON.parse(child.stdout) as string[];
  outcomes.push({
    scenario:
      "fresh process reads the same result data and reuses completed files",
    passed:
      restarted.length === 5 &&
      restarted.every((status) => status === "skipped") &&
      hits.get("/data.csv") === 3,
    detail: restarted,
  });
  const beforeResume = sourceReads;
  await rm(files[0].path);
  const resumed = await acquire({
    query: undefined,
    resume: second.manifest_path,
  });
  const repeatedResume = await acquire({
    query: undefined,
    resume: second.manifest_path,
  });
  outcomes.push({
    scenario:
      "public resume repairs a missing file and repeated resume reuses the complete batch",
    passed:
      sourceReads === beforeResume &&
      resumed.resources.length === 5 &&
      resumed.resources.filter((resource) => resource.status === "success")
        .length === 1 &&
      repeatedResume.resources.every(
        (resource) => resource.status === "skipped",
      ),
    detail: resumed.resources.map((resource) => ({
      url: resource.url,
      status: resource.status,
    })),
  });
  const movedDirectory = join(home, "moved");
  await mkdir(movedDirectory);
  const movedManifest = join(movedDirectory, "results.json");
  await writeFile(movedManifest, JSON.stringify(repeatedResume));
  const moved = await acquire({ query: undefined, resume: movedManifest });
  outcomes.push({
    scenario:
      "resume derives artifact destinations from the current result directory",
    passed:
      moved.directory === movedDirectory &&
      moved.manifest_path === movedManifest &&
      moved.resources.length === 5 &&
      moved.resources.every(
        (resource) =>
          resource.path.startsWith(movedDirectory) &&
          resource.status === "success",
      ),
  });
  const damagedManifest = join(home, "damaged.json");
  for (const body of [
    "{interrupted",
    JSON.stringify({ schema_version: "unsupported", resources: [] }),
  ]) {
    await writeFile(damagedManifest, body);
    let damageError: unknown;
    try {
      await acquireEvidenceResources("", [], { resume: damagedManifest });
    } catch (error) {
      damageError = error;
    }
    outcomes.push({
      scenario: body.startsWith("{interrupted")
        ? "damaged resume file remains untouched with a structured failure"
        : "unsupported resume schema remains untouched with a structured failure",
      passed:
        (damageError as { code?: string })?.code === "invalid_input" &&
        (await readFile(damagedManifest, "utf8")) === body,
      detail: String(damageError),
    });
  }

  const beforeDirect = sourceReads;
  const direct = await acquire({
    query: `${base}/opaque`,
    dir: join(home, "direct"),
    max_resources: 0,
  });
  outcomes.push({
    scenario: "direct URL bypasses discovery and preserves opaque binary bytes",
    passed:
      sourceReads === beforeDirect &&
      direct.candidates.length === 0 &&
      direct.resources.length === 1 &&
      direct.resources[0].contentType === "application/pdf" &&
      (await readFile(direct.resources[0].path, "utf8")).startsWith("%PDF-1.7"),
    detail: direct.resources[0],
  });
  revision = 2;
  const refreshed = await acquire({
    query: `${base}/opaque`,
    dir: direct.directory,
    refresh: true,
    max_resources: 0,
  });
  outcomes.push({
    scenario: "explicit refresh replaces a completed file atomically",
    passed:
      refreshed.resources[0].status === "success" &&
      (await readFile(refreshed.resources[0].path, "utf8")).includes(
        "revision 2",
      ) &&
      hits.get("/opaque") === 2,
  });
  const selected = await acquireEvidenceResources(
    "quartz",
    [
      resultCandidate(`${base}/unfetched`, {
        download_url: `${base}/selected`,
      }),
    ],
    { directory: join(home, "selected"), maxResources: 0 },
  );
  outcomes.push({
    scenario: "source-provided download URL retains source location",
    passed:
      selected.resources[0].url === `${base}/selected` &&
      selected.resources[0].source_urls[0] === `${base}/unfetched` &&
      !hits.has("/unfetched"),
  });
  const oneLevel = await acquire({
    query: `${base}/one-level`,
    dir: join(home, "one-level"),
  });
  outcomes.push({
    scenario: "resource exploration stops after one selected-page layer",
    passed: oneLevel.resources.length === 2 && !hits.has("/deep.pdf"),
  });
  const none = await acquire({
    query: `${base}/one-level`,
    dir: join(home, "no-links"),
    max_resources: 0,
  });
  outcomes.push({
    scenario: "zero additional resource limit keeps only the selected page",
    passed: none.resources.length === 1 && none.linked_resources_selected === 0,
  });
  const invalid = await acquire({
    query: `${base}/invalid.json`,
    dir: join(home, "invalid"),
  });
  outcomes.push({
    scenario:
      "text conversion failure retains raw file and explicit structure error",
    passed:
      invalid.resources[0].status === "success" &&
      !!invalid.resources[0].structure_error &&
      !invalid.resources[0].document_path &&
      (await readFile(invalid.resources[0].path, "utf8")) === "{invalid",
  });
  validJson = true;
  const fixedStructure = await acquire({
    query: undefined,
    resume: invalid.manifest_path,
  });
  outcomes.push({
    scenario: "resume retries source content whose structure previously failed",
    passed:
      fixedStructure.selection_complete &&
      !!fixedStructure.resources[0].document_path &&
      !fixedStructure.resources[0].structure_error &&
      hits.get("/invalid.json") === 2,
  });
  const partial = await acquireEvidenceResources(
    "download sample",
    [
      resultCandidate(`${base}/one-level`),
      resultCandidate(`${base}/recover-page`),
    ],
    { directory: join(home, "partial-root"), maxResources: 2 },
  );
  failRoot = false;
  const completed = await acquire({
    query: undefined,
    resume: partial.manifest_path,
  });
  outcomes.push({
    scenario:
      "failed root recovery fills remaining selection slots and never explores existing linked pages",
    passed:
      !partial.selection_complete &&
      partial.linked_resources_selected === 1 &&
      completed.selection_complete &&
      completed.resources.length === 4 &&
      completed.linked_resources_selected === 2 &&
      completed.resources.some(
        (resource) =>
          resource.url === `${base}/recovered.pdf` &&
          resource.status === "success",
      ) &&
      !hits.has("/deep.pdf"),
    detail: {
      first: partial.linked_resources_selected,
      resumed: completed.resources.map((resource) => resource.url),
    },
  });

  const protectedPath = join(home, "protected.pdf");
  await writeFile(protectedPath, "previous complete file");
  for (const path of [
    "/large-length",
    "/large-stream",
    "/challenge-header",
    "/challenge-body",
  ]) {
    const outcome = await httpDownload(`${base}${path}`, protectedPath, {
      maxBytes: path.startsWith("/challenge") ? 4096 : 128,
      headers: { Cookie: "scenario=explicit" },
    });
    outcomes.push({
      scenario: `${path} preserves the previous published file`,
      passed:
        outcome.status === "failed" &&
        outcome.code ===
          (path.startsWith("/challenge")
            ? "challenge_required"
            : "response_too_large") &&
        (await readFile(protectedPath, "utf8")) === "previous complete file",
      detail: outcome,
    });
  }
  for (const path of ["/retry429", "/retry503", "/interrupted"]) {
    const result = await acquire({
      query: `${base}${path}`,
      dir: join(home, path.slice(1)),
      max_resources: 0,
    });
    const times = requestTimes.get(path) ?? [];
    outcomes.push({
      scenario: `${path} retries through the shared HTTP owner before atomic publication`,
      passed:
        result.resources[0].status === "success" &&
        hits.get(path) === 2 &&
        (!path.endsWith("429") || times[1] - times[0] >= 1040) &&
        (await readFile(result.resources[0].path, "utf8")).includes(
          `%PDF-1.7\n${path}`,
        ) &&
        !(await readdir(result.directory)).some((name) => name.startsWith(".")),
      detail: { requests: hits.get(path), interval_ms: times[1] - times[0] },
    });
  }
  const retryCancelled = await acquire({
    query: `${base}/retry-cancel`,
    dir: join(home, "retry-cancel"),
    timeout_ms: 40,
    max_resources: 0,
  });
  outcomes.push({
    scenario:
      "resource deadline cancels a long Retry-After wait and removes staging",
    passed:
      retryCancelled.resources[0].code === "timeout" &&
      hits.get("/retry-cancel") === 1 &&
      (await readdir(retryCancelled.directory)).join(",") === "results.json",
  });
  saveCookies("127.0.0.1", { session: "source" });
  saveCookies("localhost", { session: "target" });
  const authenticated = await httpDownload(
    `${base}/credential-start`,
    join(home, "credential.pdf"),
  );
  outcomes.push({
    scenario:
      "redirected authentication uses each origin's persisted cookie within three credential stages",
    passed:
      authenticated.status === "success" &&
      hits.get("/credential-start") === 2 &&
      hits.get("/credential-target") === 2 &&
      !foreignCookie,
    detail: {
      status: authenticated.status,
      sourceRequests: hits.get("/credential-start"),
      targetRequests: hits.get("/credential-target"),
      foreignCookie,
    },
  });
  const beforeExplicit = hits.get("/credential-start") ?? 0;
  const explicit = await httpDownload(
    `${base}/credential-start`,
    join(home, "explicit.pdf"),
    { Cookie: "session=caller" },
  );
  const disabled = await withCredentialRecovery(false, () =>
    httpDownload(`${base}/credential-start`, join(home, "disabled.pdf")),
  );
  outcomes.push({
    scenario:
      "explicit credentials and recovery opt-out keep their caller-owned request state",
    passed:
      explicit.status === "failed" &&
      disabled.status === "failed" &&
      hits.get("/credential-start") === beforeExplicit + 2,
  });
  const timed = await acquire({
    query: `${base}/slow.pdf`,
    dir: join(home, "timeout"),
    timeout_ms: 40,
    max_resources: 0,
  });
  outcomes.push({
    scenario: "per-resource deadline is reported in persisted results",
    passed:
      timed.resources[0].status === "failed" &&
      timed.resources[0].code === "timeout",
    detail: timed.resources[0],
  });

  const cancelledDirectory = join(home, "cancelled");
  const controller = new AbortController();
  const reason = new Error("scenario cancellation");
  const pending = acquireEvidenceResources(
    "cancel resource batch",
    [
      resultCandidate(`${base}/slow.pdf`),
      resultCandidate(`${base}/slow.pdf?second`),
      resultCandidate(`${base}/never.pdf`),
    ],
    {
      directory: cancelledDirectory,
      concurrency: 2,
      signal: controller.signal,
    },
  );
  const cancelTimer = setTimeout(() => controller.abort(reason), 50);
  let cancellation: unknown;
  try {
    await pending;
  } catch (error) {
    cancellation = error;
  }
  clearTimeout(cancelTimer);
  const cancelled = JSON.parse(
    await readFile(join(cancelledDirectory, "results.json"), "utf8"),
  ) as ResourceAcquisition;
  const filesAtReturn = await readdir(cancelledDirectory);
  await delay(40);
  outcomes.push({
    scenario:
      "caller cancellation retains identity and drains workers before return",
    passed:
      cancellation === reason &&
      cancelled.resources.every(
        (resource) => resource.status === "cancelled",
      ) &&
      filesAtReturn.length === 1 &&
      filesAtReturn[0] === "results.json" &&
      JSON.stringify(await readdir(cancelledDirectory)) ===
        JSON.stringify(filesAtReturn) &&
      !hits.has("/never.pdf"),
    detail: {
      cancellation: String(cancellation),
      statuses: cancelled.resources.map((resource) => resource.status),
      filesAtReturn,
    },
  });
  slowResources = false;
  const recovered = await acquire({
    query: undefined,
    resume: cancelled.manifest_path,
  });
  outcomes.push({
    scenario:
      "cancelled first-stage selection resumes from the same result file",
    passed:
      recovered.resources.length === 3 &&
      recovered.resources.every((resource) => resource.status === "success") &&
      recovered.selection_complete &&
      hits.get("/never.pdf") === 1,
    detail: recovered.resources.map((resource) => resource.status),
  });
  slowResources = true;
  const pageController = new AbortController();
  const interruptedDirectory = join(home, "interrupted-selection");
  const interruptedSelection = acquireEvidenceResources(
    "sample",
    [resultCandidate(`${base}/one-level`), resultCandidate(`${base}/slow.pdf`)],
    { directory: interruptedDirectory, signal: pageController.signal },
  );
  const pageTimer = setTimeout(
    () => pageController.abort(new Error("Pause before link selection")),
    50,
  );
  try {
    await interruptedSelection;
  } catch {
    /* Cancellation is evaluated through the persisted state below. */
  }
  clearTimeout(pageTimer);
  slowResources = false;
  const continuedSelection = await acquire({
    query: undefined,
    resume: join(interruptedDirectory, "results.json"),
  });
  outcomes.push({
    scenario:
      "resume completes interrupted page exploration before selecting bounded resource links",
    passed:
      continuedSelection.selection_complete &&
      continuedSelection.resources.length === 3 &&
      continuedSelection.resources.some(
        (resource) =>
          resource.url === `${base}/linked.html` &&
          resource.status === "success",
      ) &&
      !hits.has("/deep.pdf"),
  });

  let activeWorkers = 0;
  const claimed: number[] = [];
  const failureReason = new Error("worker failure");
  let workerError: unknown;
  try {
    await mapConcurrent([0, 1, 2, 3], 2, async (item) => {
      activeWorkers++;
      claimed.push(item);
      try {
        await delay(item === 0 ? 5 : 30);
        if (item === 0) throw failureReason;
        return item;
      } finally {
        activeWorkers--;
      }
    });
  } catch (error) {
    workerError = error;
  }
  outcomes.push({
    scenario: "worker failure drains started work and stops unclaimed items",
    passed:
      workerError === failureReason &&
      activeWorkers === 0 &&
      claimed.join(",") === "0,1",
    detail: claimed,
  });
  let invalidConcurrency: unknown;
  try {
    await mapConcurrent([1], 0, async (item) => item);
  } catch (error) {
    invalidConcurrency = error;
  }
  outcomes.push({
    scenario: "invalid concurrency cannot silently omit work",
    passed: invalidConcurrency instanceof RangeError,
  });

  await stepDownload(
    { data: null, args: {}, vars: {} },
    {
      url: `${base}/inline`,
      dir: home,
      filename: "inline.md",
      type: "document",
      content: "Inline structured text",
      skip_existing: false,
    },
  );
  outcomes.push({
    scenario: "pipeline inline document uses the shared atomic writer",
    passed:
      (await readFile(join(home, "inline.md"), "utf8")) ===
        "Inline structured text" &&
      !(await readdir(home)).some((path) => path.startsWith(".inline")),
  });
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      passed: outcomes.filter((row) => row.passed).length,
      total: outcomes.length,
      outcomes,
    },
    null,
    2,
  ),
);
if (outcomes.some((row) => !row.passed)) process.exitCode = 1;
