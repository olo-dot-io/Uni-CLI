import { once } from "node:events";
import { createServer } from "node:http";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "unicli-internet-scenario-"));
process.env.HOME = home;
process.env.UNICLI_ALLOW_LOCAL = "1";
process.env.UNICLI_NO_LOG = "1";

const { stepFetch } = await import("../../src/engine/steps/fetch.js");
const { fetchTextResource } =
  await import("../../src/engine/steps/fetch-text.js");
const { readEvidenceDocument } =
  await import("../../src/engine/evidence-reader.js");
const { getAdapter } = await import("../../src/registry.js");
await import("../../src/adapters/web/read.js");

const outcomes: Array<{ scenario: string; passed: boolean; detail?: unknown }> =
  [];
const counts = new Map<string, number>();
const times = new Map<string, number[]>();
let revision = 1;
const markdown =
  '# Agent guide\n\nKeep <Widget prop="value"> as source.\n\n```ts\nconst n = a < b ? 1 : 2;\n```\n';
const html =
  "<html><head><title>Agent guide</title></head><body><article><h1>Agent guide</h1><p>Ordinary guide mentioning cf-turnstile and challenge-platform.</p></article></body></html>";
const challenge =
  '<!doctype html><html><head><title>Making sure you&#39;re not a bot!</title></head><body><script src="/.within.website/x/cmd/anubis/main.mjs"></script></body></html>';
const server = createServer(async (request, response) => {
  const path = request.url ?? "/";
  const count = (counts.get(path) ?? 0) + 1;
  counts.set(path, count);
  times.set(path, [...(times.get(path) ?? []), performance.now()]);
  if (path.startsWith("/retry") && count === 1) {
    response.writeHead(429, {
      "retry-after": path.includes("date")
        ? new Date(Date.now() + 1800).toUTCString()
        : path.includes("long")
          ? "2147484"
          : "0.05",
    });
    response.end("rate limited");
  } else if (path.startsWith("/interrupted") && count === 1) {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": "400",
    });
    response.write('{"partial":');
    setTimeout(() => response.destroy(), 10);
  } else if (path === "/markdown-example") {
    response.writeHead(200, { "content-type": "text/markdown" });
    response.end(challenge);
  } else if (path === "/challenge-header") {
    response.writeHead(200, {
      "content-type": "text/html",
      "cf-mitigated": "challenge",
    });
    response.end("Verification required");
  } else if (path === "/anubis") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(challenge);
  } else if (path === "/guide") {
    const native = request.headers.accept?.startsWith("text/markdown");
    response.writeHead(200, {
      "content-type": native ? "text/markdown" : "text/html",
      vary: "Accept",
    });
    response.end(native ? markdown : html);
  } else if (path === "/invalid-json") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(200, {
      "content-type": "application/json",
      ...(path === "/no-store" ? { "cache-control": "no-store" } : {}),
      ...(path === "/expired"
        ? { "cache-control": "public,max-age=1", age: "2" }
        : {}),
      ...(path === "/vary" ? { vary: "*" } : {}),
      ...(path === "/short-cache"
        ? { "cache-control": "public,max-age=1" }
        : {}),
    });
    response.end(
      JSON.stringify({
        revision,
        count,
        auth: request.headers.authorization ?? null,
        accept: request.headers.accept,
        method: request.method,
        body: Buffer.concat(chunks).toString(),
        html: path === "/embedded-challenge" ? challenge : undefined,
      }),
    );
  }
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Scenario server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const context = { data: null, args: {}, vars: {}, canMutate: false };
  const json = async (path: string, config: Record<string, unknown> = {}) =>
    (await stepFetch(context, { url: `${base}${path}`, ...config }))
      .data as Record<string, unknown>;
  async function code(action: () => Promise<unknown>): Promise<unknown> {
    try {
      await action();
      return "unexpected_success";
    } catch (error) {
      if ((error as { outcome_ambiguous?: boolean }).outcome_ambiguous)
        return "operation_outcome_ambiguous";
      return (
        (error as { detail?: { errorType?: string } }).detail?.errorType ??
        error
      );
    }
  }
  for (const owner of ["json", "text"]) {
    const path = `/retry-${owner}`;
    const result =
      owner === "json"
        ? await json(path, { retry: 2, backoff: 0 })
        : JSON.parse(
            (
              await fetchTextResource(
                `${base}${path}`,
                { url: `${base}${path}`, retry: 2, backoff: 0 },
                {},
                0,
              )
            ).text,
          );
    const attempts = times.get(path) ?? [];
    outcomes.push({
      scenario: `${owner} respects Retry-After before the next attempt`,
      passed: result.count === 2 && attempts[1] - attempts[0] >= 45,
      detail: attempts[1] - attempts[0],
    });
    for (const endpoint of ["challenge-header", "anubis"]) {
      const error = await code(() =>
        owner === "json"
          ? json(`/${endpoint}`)
          : fetchTextResource(
              `${base}/${endpoint}`,
              { url: `${base}/${endpoint}` },
              {},
              0,
            ),
      );
      outcomes.push({
        scenario: `${owner} classifies ${endpoint} before successful parsing`,
        passed: error === "challenge_required",
        detail: error,
      });
    }
    const interrupted = `/interrupted-${owner}`;
    const recovered =
      owner === "json"
        ? await json(interrupted, { retry: 2, backoff: 0 })
        : JSON.parse(
            (
              await fetchTextResource(
                `${base}${interrupted}`,
                { url: `${base}${interrupted}`, retry: 2, backoff: 0 },
                {},
                0,
              )
            ).text,
          );
    outcomes.push({
      scenario: `${owner} retries an interrupted body within the same attempt budget`,
      passed: recovered.count === 2 && counts.get(interrupted) === 2,
    });
    const controller = new AbortController();
    const reason = new Error(`${owner} cancelled retry wait`);
    setTimeout(() => controller.abort(reason), 35);
    const long = `/retry-long-${owner}`;
    const cancelled = await code(() =>
      owner === "json"
        ? stepFetch(
            { ...context, signal: controller.signal },
            { url: `${base}${long}`, retry: 2, backoff: 0 },
          )
        : fetchTextResource(
            `${base}${long}`,
            { url: `${base}${long}`, retry: 2, backoff: 0 },
            {},
            0,
            { signal: controller.signal },
          ),
    );
    outcomes.push({
      scenario: `${owner} cancels an overflow-sized retry window without replay`,
      passed: cancelled === reason && counts.get(long) === 1,
    });
  }
  for (const owner of ["json", "text"]) {
    const path = `/interrupted-write-${owner}`;
    const error = await code(() =>
      owner === "json"
        ? json(path, {
            method: "POST",
            body: { revision: 3 },
            retry: 2,
            backoff: 0,
          })
        : fetchTextResource(
            `${base}${path}`,
            {
              url: `${base}${path}`,
              method: "POST",
              body: { revision: 3 },
              retry: 2,
              backoff: 0,
            },
            {},
            0,
          ),
    );
    outcomes.push({
      scenario: `${owner} accepted writes with interrupted responses are reconciled without replay`,
      passed: error === "operation_outcome_ambiguous" && counts.get(path) === 1,
      detail: error,
    });
  }
  const dateStarted = performance.now();
  await json("/retry-date", { retry: 2, backoff: 0 });
  outcomes.push({
    scenario: "HTTP-date retry windows reach the request path",
    passed:
      performance.now() - dateStarted >= 700 && counts.get("/retry-date") === 2,
  });
  const native = await readEvidenceDocument(`${base}/guide`);
  outcomes.push({
    scenario: "native Markdown is negotiated and preserved literally",
    passed:
      native.content_type === "text/markdown" && native.content === markdown,
  });
  const example = await readEvidenceDocument(`${base}/markdown-example`);
  outcomes.push({
    scenario:
      "native Markdown containing HTML challenge examples remains content",
    passed: example.content === challenge,
  });
  const asHtml = await readEvidenceDocument(`${base}/guide`, {
    representation: "html",
  });
  outcomes.push({
    scenario:
      "HTML representation keeps HTML negotiation and ordinary challenge prose",
    passed:
      asHtml.content_type === "text/html" &&
      asHtml.content.includes("cf-turnstile"),
  });
  const webRead = getAdapter("web")?.commands.read;
  const webResult = await webRead?.func?.(
    null as never,
    { url: `${base}/guide` },
    { signal: undefined } as never,
  );
  outcomes.push({
    scenario:
      "web read and extract share native Markdown without a second converter",
    passed: webResult === native.content,
  });
  outcomes.push({
    scenario: "non-JSON responses retain invalid_content",
    passed: (await code(() => json("/invalid-json"))) === "invalid_content",
  });
  outcomes.push({
    scenario: "JSON containing challenge markup remains JSON data",
    passed: (await json("/embedded-challenge")).html === challenge,
  });
  for (const body of [null, false, 0, { revision: 1 }]) {
    const value = await json("/body", {
      method: "post",
      body,
      headers: { "content-type": "application/json" },
    });
    outcomes.push({
      scenario: `JSON body preserves ${JSON.stringify(body)}`,
      passed: value.method === "POST" && value.body === JSON.stringify(body),
    });
  }
  await json("/cache", { cache: 60 });
  revision = 2;
  const cached = await json("/cache", { cache: 60 });
  outcomes.push({
    scenario: "repeated read reuses a fresh response",
    passed: cached.revision === 1 && counts.get("/cache") === 1,
  });
  const refreshed = await json("/cache", { cache: 0 });
  outcomes.push({
    scenario: "explicit freshness bypass reads current source",
    passed: refreshed.revision === 2 && counts.get("/cache") === 2,
  });
  for (const auth of ["Bearer first", "Bearer second"])
    await json("/identity", { cache: 60, headers: { authorization: auth } });
  const first = await json("/identity", {
    cache: 60,
    headers: { Authorization: "Bearer first" },
  });
  outcomes.push({
    scenario:
      "credentials partition cache while header casing remains equivalent",
    passed: first.auth === "Bearer first" && counts.get("/identity") === 2,
  });
  for (const accept of ["application/json", "application/vnd.example+json"])
    await json("/representation", { cache: 60, headers: { accept } });
  outcomes.push({
    scenario: "Accept partitions cached representations",
    passed: counts.get("/representation") === 2,
  });
  for (const path of ["/no-store", "/expired", "/vary"]) {
    await json(path, { cache: 60 });
    await json(path, { cache: 60 });
    outcomes.push({
      scenario: `${path} origin policy disables reuse`,
      passed: counts.get(path) === 2,
    });
  }
  await json("/post-cache", {
    cache: 60,
    method: "POST",
    body: { revision: 1 },
  });
  await json("/post-cache", {
    cache: 60,
    method: "POST",
    body: { revision: 2 },
  });
  outcomes.push({
    scenario: "writes execute instead of reading cached mutation results",
    passed: counts.get("/post-cache") === 2,
  });
  const cacheDir = join(home, ".unicli", "cache");
  const cachePath = readdirSync(cacheDir)
    .map((name) => join(cacheDir, name))
    .find(
      (path) =>
        JSON.parse(readFileSync(path, "utf8")).requested_url ===
        `${base}/cache`,
    );
  if (!cachePath) throw new Error("Scenario cache was not created");
  const entry = JSON.parse(readFileSync(cachePath, "utf8"));
  const childSource = `import { stepFetch } from ${JSON.stringify(new URL("../../src/engine/steps/fetch.ts", import.meta.url).href)}; const result = await stepFetch({data:null,args:{},vars:{},canMutate:false},{url:${JSON.stringify(`${base}/cache`)},cache:60}); console.log(JSON.stringify(result.data));`;
  const restarted = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childSource],
    { encoding: "utf8", env: process.env, timeout: 3000 },
  );
  outcomes.push({
    scenario: "cache survives process restart",
    passed:
      restarted.status === 0 &&
      JSON.parse(restarted.stdout || "null")?.revision === 1,
    detail: restarted.stderr || undefined,
  });
  writeFileSync(
    cachePath,
    JSON.stringify({ ...entry, expires_at: Date.now() - 1 }),
  );
  const expired = await json("/cache", { cache: 60 });
  outcomes.push({
    scenario: "expired persistent cache converges to current data",
    passed: expired.revision === 2,
  });
  writeFileSync(cachePath, "partial interrupted file");
  const recovered = await json("/cache", { cache: 60 });
  outcomes.push({
    scenario: "partial cache recovers through the normal read path",
    passed:
      recovered.revision === 2 &&
      JSON.parse(readFileSync(cachePath, "utf8")).schema_version ===
        "fetch-cache.v2",
  });
  outcomes.push({
    scenario: "atomic cache publication leaves no abandoned staging directory",
    passed: readdirSync(cacheDir).every((name) => name.endsWith(".json")),
  });
  console.log(
    JSON.stringify(
      {
        suite: "internet-access",
        passed: outcomes.filter((row) => row.passed).length,
        total: outcomes.length,
        outcomes,
      },
      null,
      2,
    ),
  );
  if (outcomes.some((row) => !row.passed)) process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
}
