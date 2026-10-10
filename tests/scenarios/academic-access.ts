import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const home = await mkdtemp(join(tmpdir(), "unicli-academic-access-"));
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.UNICLI_COOKIE_DIR = join(home, "cookies");
process.env.UNICLI_COOKIE_NO_BROWSER = "1";
for (const key of Object.keys(process.env)) {
  if (/^(?:https?|all|no)_proxy$/i.test(key)) delete process.env[key];
}

const failures: string[] = [];
const requests: URL[] = [];
let revision = 1;
let unavailable = true;
let dblpChallenge = false;
let dblpMalformed = false;
let openReviewExpired = false;
let openReviewCredential = "";
let cancellationStarted: (() => void) | undefined;
const models = [
  {
    id: "example/agent-latest",
    name: "Agent Latest",
    created: 3,
    context_length: 128000,
    pricing: { prompt: "0.000001", completion: "0.000003" },
  },
  {
    id: "example/agent-middle",
    name: "Agent Middle",
    created: 2,
    context_length: 64000,
    pricing: { prompt: "0", completion: "0" },
  },
  {
    id: "example/agent-first",
    name: "Agent First",
    created: 1,
    context_length: 32000,
    pricing: { prompt: "0.0000001", completion: "0.0000002" },
  },
];
const paper = {
  id: "paperAlpha1",
  forum: "paperAlpha1",
  pdate: 1760000000000,
  content: {
    title: { value: "Paper Alpha" },
    authors: { value: ["Jane Doe"] },
    authorids: { value: ["~Jane_Doe1"] },
    pdf: { value: "/pdf?id=paperAlpha1" },
  },
};
const legacyPaper = {
  id: "paperBeta12",
  forum: "paperBeta12",
  content: {
    title: "Paper Beta",
    authors: ["Jane Doe"],
    authorids: ["~Jane_Doe1"],
  },
};
const graphBindings = [
  {
    paper: { type: "uri", value: "https://dblp.org/rec/conf/demo/Alpha24" },
    title: { type: "literal", value: 'A "Graph Database" paper' },
    year: {
      type: "literal",
      datatype: "http://www.w3.org/2001/XMLSchema#gYear",
      value: "2024",
    },
  },
];
const record = (key: string, year: string): string =>
  `<inproceedings key='${key}'><author pid='56/953'>Jane Doe 0001</author><title>A &amp; B <i>with markup</i>.</title><year>${year}</year><booktitle>Conference</booktitle><ee>https://doi.org/10.1234/example</ee></inproceedings>`;
const json = (body: unknown, cache?: string): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      ...(cache ? { "cache-control": cache } : {}),
    },
  });

// REASON: public HTTP is the external boundary; registry commands, parsing, pagination, cancellation and disk caching remain real.
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  requests.push(url);
  if (url.hostname === "openrouter.ai") {
    if (url.pathname.includes("/model/"))
      return json(
        { data: { ...models[0], revision, description: "Full model details" } },
        "public, max-age=300",
      );
    if (url.searchParams.get("q") === "unavailable" && unavailable)
      return new Response("Unavailable", { status: 503 });
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? models.length);
    return json(
      {
        data: models.slice(offset, offset + limit),
        total_count: models.length,
        links: {
          next:
            offset + limit < models.length
              ? `https://openrouter.ai/api/v1/models?offset=${offset + limit}`
              : null,
        },
      },
      `public, max-age=${url.searchParams.get("q") === "expire" ? 1 : 120}`,
    );
  }
  if (url.hostname === "sparql.dblp.org" && url.pathname === "/sparql")
    return new Response(
      JSON.stringify({
        head: { vars: ["paper", "title", "year"] },
        results: { bindings: graphBindings },
      }),
      { headers: { "content-type": "application/sparql-results+json" } },
    );
  if (url.hostname === "dblp.org") {
    if (cancellationStarted) {
      cancellationStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    }
    if (dblpChallenge)
      return new Response(
        '<html><title>Making sure you&#39;re not a bot!</title><script src="/.within.website/x/cmd/anubis/static/js/main.mjs"></script></html>',
        { headers: { "content-type": "text/html" } },
      );
    if (dblpMalformed)
      return new Response("not json", {
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/search/publ/api")
      return json({
        result: {
          status: { "@code": "200" },
          hits: {
            "@total": "3",
            hit: {
              info: {
                key: "conf/demo/Alpha24",
                title: "A &amp; B <i>with markup</i>.",
                authors: { author: { text: "Jane Doe 0001" } },
                year: "2024",
              },
            },
          },
        },
      });
    if (url.pathname === "/search/author/api")
      return json({
        result: {
          hits: {
            hit: [
              {
                info: {
                  author: "Jane Doe 0001",
                  url: "https://dblp.org/pid/56/953",
                },
              },
              {
                info: {
                  author: "Jane Doe 0002",
                  url: "https://dblp.org/pid/56/954",
                },
              },
            ],
          },
        },
      });
    if (url.pathname.startsWith("/pid/"))
      return new Response(
        `<dblpperson><r>${record("conf/demo/Old20", "2020")}</r><r>${record("conf/demo/New25", "2025")}</r><r>${record("conf/demo/Alpha24", "2024")}</r><r><crossref>conf/demo</crossref></r></dblpperson>`,
        { headers: { "content-type": "application/xml" } },
      );
    return new Response(`<dblp>${record("conf/demo/Alpha24", "2024")}</dblp>`, {
      headers: { "content-type": "application/xml" },
    });
  }
  if (url.hostname === "api2.openreview.net") {
    const headers = new Headers(init?.headers);
    openReviewCredential =
      headers.get("authorization") === "Bearer scenario-fresh-access" &&
      headers
        .get("cookie")
        ?.includes("openreview.accessToken=scenario-fresh-access")
        ? "fresh"
        : headers.get("authorization") === "Bearer scenario-old-access"
          ? "old"
          : "absent";
    if (openReviewExpired && openReviewCredential !== "fresh")
      return new Response(
        '{"name":"TokenExpiredError","message":"Token has expired"}',
        { status: 401, headers: { "content-type": "application/json" } },
      );
    if (url.pathname === "/notes/search")
      return json({
        notes:
          url.searchParams.get("source") === "papers"
            ? [paper, legacyPaper]
            : [
                {
                  id: "reviewAlpha",
                  forum: paper.id,
                  content: { title: { value: "A titled review" } },
                },
                paper,
              ],
      });
    return json({ notes: [paper] });
  }
  throw new Error(`Unexpected scenario request ${url}`);
};

try {
  await import("../../src/adapters/openrouter/models.js");
  await import("../../src/adapters/dblp/publications.js");
  await import("../../src/adapters/openreview/papers.js");
  const { resolveCommand } = await import("../../src/registry.js");
  const { resetOpenReviewRequestSchedulerForTests } =
    await import("../../src/adapters/openreview/client.js");
  const { saveCookies, readDiskCookies } =
    await import("../../src/engine/cookie-storage.js");
  const { refreshCookiesFromBrowser, runWithCookieInvocationOverride } =
    await import("../../src/engine/cookies.js");
  const { readEvidenceDocument } =
    await import("../../src/engine/evidence-reader.js");
  const run = async (
    site: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> => {
    const command = resolveCommand(site, name)?.command;
    if (!command?.func) throw new Error(`Missing command ${site}.${name}`);
    // REASON: API-only commands receive the kernel's null-page contract.
    return (await command.func(null as never, args, { signal })) as Array<
      Record<string, unknown>
    >;
  };

  const searchArgs = { query: "agent", limit: 2, offset: 0, sort: "newest" };
  const first = await run("openrouter", "search", searchArgs);
  if (
    requests.length !== 1 ||
    requests[0].searchParams.get("q") !== "agent" ||
    requests[0].searchParams.get("limit") !== "2" ||
    requests[0].searchParams.get("sort") !== "newest"
  )
    failures.push(
      "OpenRouter did not delegate filtering, bounds and ordering to one API request",
    );
  if (
    first.length !== 2 ||
    first[0].next_offset !== 2 ||
    first[0].total_count !== 3 ||
    first[0].context !== "128000" ||
    first[1].prompt_price !== "0"
  )
    failures.push(
      "OpenRouter search lost pagination, legacy fields or zero pricing",
    );
  await run("openrouter", "search", searchArgs);
  const listed = await run("openrouter", "models", searchArgs);
  if (requests.length !== 1)
    failures.push(
      "OpenRouter search and models failed to reuse the same public response",
    );
  if (listed[0].context_length !== "128000")
    failures.push("OpenRouter models changed its legacy context field type");
  const last = await run("openrouter", "search", {
    ...searchArgs,
    offset: first[0].next_offset,
  });
  if (
    last[0].id !== models[2].id ||
    last[0].rank !== 3 ||
    last[0].next_offset !== null
  )
    failures.push("OpenRouter next-page flow repeated or omitted a model");

  const detail = await run("openrouter", "model", { id: first[0].id });
  if (
    detail[0].description !== "Full model details" ||
    detail[0].context_length !== 128000 ||
    !requests.at(-1)?.pathname.includes("/model/example/agent-latest")
  )
    failures.push("OpenRouter detail failed to use the single-model endpoint");
  revision = 2;
  const cached = await run("openrouter", "model", { id: first[0].id });
  const refreshed = await run("openrouter", "model", {
    id: first[0].id,
    fresh: true,
  });
  if (cached[0].revision !== 1 || refreshed[0].revision !== 2)
    failures.push("OpenRouter fresh did not bypass the cached model response");
  const restart = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `globalThis.fetch=async()=>{throw new Error('cache miss after restart')}; await import('./src/adapters/openrouter/models.ts'); const {resolveCommand}=await import('./src/registry.ts'); console.log(JSON.stringify(await resolveCommand('openrouter','search').command.func(undefined,${JSON.stringify(searchArgs)},{})));`,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  if (restart.status !== 0 || JSON.parse(restart.stdout)[0]?.id !== first[0].id)
    failures.push(
      `OpenRouter restart failed to consume the committed cache ${restart.stderr}`,
    );
  const expiryStart = requests.length;
  await run("openrouter", "search", { query: "expire", limit: 1 });
  await delay(1100);
  await run("openrouter", "search", { query: "expire", limit: 1 });
  if (requests.length !== expiryStart + 2)
    failures.push("OpenRouter ignored the provider's shorter cache max-age");
  let failureCode: string | undefined;
  try {
    await run("openrouter", "search", { query: "unavailable", limit: 1 });
  } catch (error) {
    failureCode = (error as { detail?: { errorType?: string } }).detail
      ?.errorType;
  }
  unavailable = false;
  const recovered = await run("openrouter", "search", {
    query: "unavailable",
    limit: 1,
  });
  if (failureCode !== "http_error" || recovered[0].id !== first[0].id)
    failures.push(
      "OpenRouter failure/recovery concealed the HTTP cause or cached a failure",
    );

  const invalidStart = requests.length;
  try {
    await run("openrouter", "search", { limit: -1 });
    failures.push("Negative OpenRouter pagination succeeded");
  } catch (error) {
    if ((error as { code?: string }).code !== "invalid_input")
      failures.push("Invalid OpenRouter pagination lost its input error");
  }
  if (requests.length !== invalidStart)
    failures.push("Invalid OpenRouter input issued a request");
  const abort = new AbortController();
  const abortReason = new Error("Scenario cancellation");
  abort.abort(abortReason);
  try {
    await run("openrouter", "search", searchArgs, abort.signal);
    failures.push("Cancelled OpenRouter cache read succeeded");
  } catch (error) {
    if (error !== abortReason)
      failures.push(
        "Cancelled OpenRouter cache read replaced the cancellation reason",
      );
  }

  const bibliography = await run("dblp", "search", {
    query: "A & B",
    limit: 1,
    offset: 1,
  });
  if (
    requests.at(-1)?.searchParams.get("f") !== "1" ||
    bibliography[0].rank !== 2 ||
    bibliography[0].title !== "A & B with markup"
  )
    failures.push("DBLP search lost offset, rank or XML text");
  const publication = await run("dblp", "paper", {
    key: `https://dblp.org/rec/${bibliography[0].key}.html`,
  });
  if (
    publication[0].title !== bibliography[0].title ||
    publication[0].open_access_url !== "" ||
    publication[0].source_url !== "https://doi.org/10.1234/example" ||
    (publication[0].author_pids as string[])?.[0] !== "56/953"
  )
    failures.push(
      "DBLP detail lost nested text, author identity or falsely labeled a publisher URL open access",
    );
  const authorPublications = await run("dblp", "author", {
    pid: (publication[0].author_pids as string[])[0],
    limit: 1,
    offset: 1,
  });
  if (
    authorPublications[0].key !== bibliography[0].key ||
    authorPublications[0].rank !== 2
  )
    failures.push(
      "DBLP author pagination occurred before chronological ordering",
    );
  const ambiguousStart = requests.length;
  try {
    await run("dblp", "author", { author: "Jane Doe" });
    failures.push("Ambiguous DBLP author silently selected a profile");
  } catch (error) {
    if ((error as { alternatives?: string[] }).alternatives?.length !== 2)
      failures.push("DBLP author ambiguity omitted usable PID alternatives");
  }
  if (requests.length !== ambiguousStart + 1)
    failures.push("DBLP fetched an arbitrary ambiguous author's publications");
  dblpChallenge = true;
  try {
    await run("dblp", "search", { query: "challenge" });
    failures.push("DBLP HTML challenge succeeded as bibliographic data");
  } catch (error) {
    if (
      (error as { detail?: { errorType?: string } }).detail?.errorType !==
      "challenge_required"
    )
      failures.push("DBLP challenge lost its structured cause");
  }
  for (const args of [
    {
      query: '  Graph "Database" \\ O\'Reilly\n中文 ")) } #  ',
      limit: 2,
      offset: 3,
    },
    { query: "图数据库", limit: 100, offset: Number.MAX_SAFE_INTEGER },
    { query: "graph databases" },
  ]) {
    let continuation: string | undefined;
    try {
      await run("dblp", "search", args);
      failures.push("DBLP challenge was silently replaced by graph results");
    } catch (error) {
      const detail = (
        error as {
          detail?: {
            errorType?: string;
            url?: string;
            statusCode?: number;
            suggestion?: string;
            alternatives?: string[];
          };
        }
      ).detail;
      continuation = detail?.alternatives?.[0];
      if (
        detail?.errorType !== "challenge_required" ||
        detail.statusCode !== 200 ||
        !detail.url?.startsWith("https://dblp.org/search/publ/api?") ||
        !detail.suggestion?.includes("case-insensitive literal title phrase") ||
        !detail.suggestion.includes("year descending")
      )
        failures.push(
          "DBLP continuation lost its source failure or distinct query semantics",
        );
    }
    const urlValue = continuation?.match(
      /^unicli extract '([^']+)' -f json$/,
    )?.[1];
    if (!urlValue) {
      failures.push(
        "DBLP graph continuation was not a shell-safe extract command",
      );
      continue;
    }
    const url = new URL(urlValue);
    const sparql = url.searchParams.get("query") ?? "";
    const literal = sparql.match(/LCASE\(("(?:\\.|[^"\\])*")\)\)\)/)?.[1];
    if (
      url.origin !== "https://sparql.dblp.org" ||
      url.pathname !== "/sparql" ||
      !literal ||
      JSON.parse(literal) !== args.query.trim() ||
      !sparql.endsWith(
        `ORDER BY DESC(?year) ?paper LIMIT ${args.limit ?? 20} OFFSET ${args.offset ?? 0}`,
      )
    )
      failures.push(
        "DBLP graph URL changed literal query text, bounds or ordering",
      );
    const document = await readEvidenceDocument(urlValue);
    const result = document.structured_data as {
      results?: { bindings?: unknown[] };
    };
    if (
      document.content_format !== "json" ||
      document.source_url !== urlValue ||
      document.http_status !== 200 ||
      JSON.stringify(result?.results?.bindings) !==
        JSON.stringify(graphBindings)
    )
      failures.push(
        "DBLP continuation failed to preserve SPARQL rows through the extract reader",
      );
  }
  for (const args of [
    { query: " \n\t " },
    { query: "graph", limit: 101 },
    { query: "graph", offset: -1 },
    { query: "graph", offset: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const before = requests.length;
    try {
      await run("dblp", "search", args);
      failures.push("Invalid DBLP search produced a query continuation");
    } catch (error) {
      if ((error as { code?: string }).code !== "invalid_input")
        failures.push("Invalid DBLP search lost its input boundary");
    }
    if (requests.length !== before)
      failures.push("Invalid DBLP search reached the network");
  }
  dblpChallenge = false;
  dblpMalformed = true;
  try {
    await run("dblp", "search", { query: "malformed" });
    failures.push("Malformed DBLP JSON succeeded");
  } catch (error) {
    if ((error as { code?: string }).code !== "upstream_error")
      failures.push("Malformed DBLP JSON became an internal error");
  }
  dblpMalformed = false;
  const pendingAbort = new AbortController();
  const started = new Promise<void>((resolve) => {
    cancellationStarted = resolve;
  });
  const pending = run(
    "dblp",
    "search",
    { query: "cancel" },
    pendingAbort.signal,
  );
  await started;
  pendingAbort.abort(abortReason);
  try {
    await pending;
    failures.push("Cancelled DBLP request succeeded");
  } catch (error) {
    if (error !== abortReason)
      failures.push("DBLP cancellation replaced the caller's reason");
  }
  cancellationStarted = undefined;
  await run("dblp", "search", { query: "recovered", limit: 1 });

  saveCookies("openreview", {
    "openreview.accessToken": "scenario-old-access",
  });
  const reviewStart = requests.length;
  const reviews = await run("openreview", "search", {
    query: "Paper",
    limit: 2,
    offset: 2,
  });
  const searchUrl = requests.at(-1)!;
  if (
    requests.length !== reviewStart + 1 ||
    searchUrl.searchParams.get("source") !== "papers" ||
    searchUrl.searchParams.get("limit") !== "2" ||
    searchUrl.searchParams.get("offset") !== "2" ||
    searchUrl.searchParams.has("type")
  )
    failures.push("OpenReview search retained overfetching or forum hydration");
  if (
    reviews[0].id !== paper.id ||
    reviews[1].title !== "Paper Beta" ||
    reviews[0].rank !== 3 ||
    (reviews[0].author_ids as string[])?.[0] !== "~Jane_Doe1"
  )
    failures.push(
      "OpenReview search confused review identity, legacy content or author profiles",
    );
  const reviewPaper = await run("openreview", "paper", {
    id: reviews[0].source_url,
  });
  const reviewAuthor = await run("openreview", "author", {
    profile: `https://openreview.net/profile?id=${(reviewPaper[0].author_ids as string[])[0]}`,
    limit: 1,
    offset: 3,
  });
  if (
    requests.at(-1)?.searchParams.get("content.authorids") !== "~Jane_Doe1" ||
    requests.at(-1)?.searchParams.get("offset") !== "3" ||
    requests.at(-1)?.searchParams.get("sort") !== "cdate:desc" ||
    reviewAuthor[0].rank !== 4
  )
    failures.push(
      "OpenReview paper-to-author flow lost canonical profile, sorting or pagination",
    );
  openReviewExpired = true;
  resetOpenReviewRequestSchedulerForTests();
  try {
    await run("openreview", "search", { query: "auth", limit: 1 });
    failures.push("Expired OpenReview authentication succeeded");
  } catch (error) {
    if ((error as { code?: string }).code !== "auth_required")
      failures.push("OpenReview lost its authentication failure identity");
  }
  // REASON: CDP credentials are an external boundary; opaque invocation overrides and the command-owned HTTP client remain real.
  const refresh = await refreshCookiesFromBrowser(
    "openreview",
    "openreview.net",
    { preferCdp: true },
    {
      readDisk: readDiskCookies,
      readBrowser: async () => {
        throw new Error(
          "Authentication scenario unexpectedly used a browser profile",
        );
      },
      readCdp: async () => ({
        "openreview.accessToken": "scenario-fresh-access",
      }),
    },
  );
  if (!refresh.ok) throw new Error("OpenReview credential refresh failed");
  resetOpenReviewRequestSchedulerForTests();
  await runWithCookieInvocationOverride(refresh.invocation_override, () =>
    run("openreview", "search", { query: "recovered", limit: 2 }),
  );
  if (openReviewCredential !== "fresh")
    failures.push("OpenReview retry reused an earlier invocation's credential");
  resetOpenReviewRequestSchedulerForTests();
  try {
    await run("openreview", "search", { query: "outside-override", limit: 1 });
    failures.push(
      "OpenReview retained a one-invocation credential in a later command",
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "auth_required")
      failures.push(
        "OpenReview credential lifetime lost its auth failure identity",
      );
  }
  saveCookies("openreview", {
    "openreview.accessToken": "scenario-fresh-access",
  });
  resetOpenReviewRequestSchedulerForTests();
  await run("openreview", "search", { query: "recovered", limit: 2 });
  if (openReviewCredential !== "fresh")
    failures.push(
      "OpenReview ignored explicitly replaced persisted credentials",
    );
  try {
    await run(
      "openreview",
      "search",
      { query: "cancel", limit: 1 },
      abort.signal,
    );
    failures.push("Cancelled OpenReview search succeeded");
  } catch (error) {
    if (error !== abortReason)
      failures.push("OpenReview cancellation replaced the caller's reason");
  }
  console.log(
    JSON.stringify(
      {
        requests: requests.length,
        workflows: [
          "model search, pagination, details, fresh, restart, expiry and recovery",
          "bibliography search, details, author, explicit graph continuation, query escaping, bounds and cancellation",
          "paper search, details, author, authentication recovery and cancellation",
        ],
        failures,
      },
      null,
      2,
    ),
  );
} finally {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env))
    if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(home, { recursive: true, force: true });
}
if (failures.length > 0) process.exitCode = 1;
