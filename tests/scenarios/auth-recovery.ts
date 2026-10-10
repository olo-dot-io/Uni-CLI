import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InMemoryBrowserRuntimeHarness } from "../helpers/in-memory-browser-runtime.js";
import { createBrowserInvocationContext } from "../../src/browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  runBrowserInvocation,
} from "../../src/browser/invocation-scope.js";

const home = mkdtempSync(join(tmpdir(), "unicli-auth-recovery-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.UNICLI_COOKIE_DIR = join(home, "cookies");
process.env.UNICLI_ALLOW_LOCAL = "1";
process.env.UNICLI_NO_LOG = "1";
const { defaultCookieSources } =
  await import("../../src/engine/cookie-source.js");
const { saveCookies, readDiskCookies } =
  await import("../../src/engine/cookie-storage.js");
const { acquireCookies } = await import("../../src/engine/cookies.js");
const { readEvidenceDocument } =
  await import("../../src/engine/evidence-reader.js");
const { buildInvocation, execute } =
  await import("../../src/engine/kernel/execute.js");
const { compileAll } = await import("../../src/engine/kernel/compile.js");
const { getAdapter, registerAdapter } = await import("../../src/registry.js");
const { AdapterType, Strategy } = await import("../../src/types.js");
const { PipelineError } = await import("../../src/engine/executor.js");
import type { AdapterManifest, OperationEffect } from "../../src/types.js";
import type { Invocation } from "../../src/engine/kernel/types.js";

const failures: string[] = [];
let browserReads = 0;
const originalBrowser = defaultCookieSources.readBrowser;
// REASON: Browser storage and OS keychain are external boundaries; keep acquisition, disk, kernel and HTTP execution real.
defaultCookieSources.readBrowser = async (domain) => {
  browserReads++;
  await new Promise((resolve) => setTimeout(resolve, 2));
  return { kind: "ok", cookies: { session: domain } };
};
const attempts = new Map<string, number>();
function adapter(
  site: string,
  effect: OperationEffect = "read",
  reject = false,
  declaresAuth = true,
): AdapterManifest {
  const domain = `${site}.example`;
  saveCookies(site, { session: "expired" });
  return {
    name: site,
    domain,
    type: AdapterType.WEB_API,
    commands: {
      read: {
        name: "read",
        operation_effect: effect,
        strategy: Strategy.PUBLIC,
        auth_requirement: declaresAuth ? "optional" : "none",
        adapterArgs: [],
        func: async () => {
          attempts.set(site, (attempts.get(site) ?? 0) + 1);
          const credential = await acquireCookies(site, domain);
          if (
            reject ||
            credential.status !== "loaded" ||
            credential.cookies.session !== domain
          ) {
            throw new PipelineError(
              "The source rejected the expired session.",
              {
                step: 0,
                action: "fetch",
                config: {},
                errorType: "auth_required",
                preserveErrorCode: true,
              },
            );
          }
          return { site, authenticated: true };
        },
      },
    },
  };
}
async function run(
  site: string,
  surface: Invocation["surface"] = "cli",
  options: Parameters<typeof buildInvocation>[4] = {},
) {
  const invocation = buildInvocation(
    surface,
    site,
    "read",
    { args: {}, source: "internal" },
    { approved: true, ...options },
  );
  if (!invocation) throw new Error(`Missing scenario command ${site}`);
  return execute(invocation);
}
const requestCounts = new Map<string, number>();
let crossOriginCookieForwarded = false;
const server = createServer((request, response) => {
  const path = request.url ?? "/";
  requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
  if (
    path === "/redirect-public" ||
    (path === "/redirect-auth" &&
      request.headers.cookie === "session=127.0.0.1")
  ) {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing redirect port");
    response.writeHead(302, {
      location: `http://localhost:${address.port}/${path === "/redirect-public" ? "target-auth" : "target-cross-origin"}`,
    });
    response.end();
    return;
  }
  if (path.startsWith("/target-")) {
    if (request.headers.cookie === "session=127.0.0.1")
      crossOriginCookieForwarded = true;
    if (request.headers.cookie !== "session=localhost") {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("Sign in to the redirected source.");
      return;
    }
    response.writeHead(200, { "content-type": "text/markdown" });
    response.end("# Redirected private resource");
    return;
  }
  if (path !== "/public" && request.headers.cookie !== "session=127.0.0.1") {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end("Sign in to read this document.");
    return;
  }
  response.writeHead(200, { "content-type": "text/markdown" });
  response.end("# Research resource\n\nA readable authenticated document.\n");
});
server.listen(0);
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Missing HTTP address");
const base = `http://127.0.0.1:${address.port}`;
const runtime = new InMemoryBrowserRuntimeHarness();
try {
  const surfaces = ["cli", "mcp", "acp", "bench", "hub"] as const;
  const publicChallenge = adapter("recovery-challenge", "read", true, false);
  publicChallenge.commands.read.func = async () => {
    throw new PipelineError("The public API returned a verification page.", {
      step: 0,
      action: "fetch",
      config: {},
      errorType: "challenge_required",
      preserveErrorCode: true,
      suggestion: "Inspect the public source in the browser.",
      alternatives: ["unicli browser doctor --json"],
    });
  };
  const adapters = [
    ...surfaces.map((surface) => adapter(`recovery-${surface}`)),
    adapter("recovery-rejected", "read", true),
    adapter("recovery-disabled"),
    adapter("recovery-write", "account_state"),
    adapter("recovery-public", "read", true, false),
    adapter("recovery-cancel"),
    publicChallenge,
  ];
  for (const item of adapters) registerAdapter(item);
  compileAll(adapters);
  const results = await Promise.all(
    surfaces.map((surface) => run(`recovery-${surface}`, surface)),
  );
  for (let i = 0; i < results.length; i++) {
    const site = `recovery-${surfaces[i]}`;
    if (
      results[i].exitCode !== 0 ||
      attempts.get(site) !== 2 ||
      JSON.stringify(results[i].results) !==
        JSON.stringify([{ site, authenticated: true }])
    )
      failures.push(`${surfaces[i]} failed bounded recovery`);
    const persisted = readDiskCookies(site);
    if (persisted.kind !== "ok" || persisted.cookies.session !== "expired")
      failures.push(`${surfaces[i]} unexpectedly persisted live cookies`);
  }
  const rejected = await run("recovery-rejected");
  if (
    rejected.error?.code !== "auth_required" ||
    attempts.get("recovery-rejected") !== 2
  )
    failures.push("Rejected fresh credentials exceeded the retry bound");
  const priorBrowserReads = browserReads;
  for (const [site, options] of [
    ["recovery-disabled", { authRetry: false }],
    ["recovery-write", {}],
    ["recovery-public", {}],
  ] as const) {
    const result = await run(site, "cli", options);
    if (result.error?.code !== "auth_required" || attempts.get(site) !== 1)
      failures.push(`${site} replayed unexpectedly`);
  }
  if (browserReads !== priorBrowserReads)
    failures.push("Non-retryable invocations accessed the browser");
  const challenged = await run("recovery-challenge");
  const recoveryCommands =
    challenged.envelope.next_actions?.map((action) => action.command) ?? [];
  if (
    challenged.error?.code !== "challenge_required" ||
    browserReads !== priorBrowserReads ||
    !recoveryCommands.includes("unicli browser doctor --json") ||
    !recoveryCommands.includes(
      "unicli browser open https://recovery-challenge.example",
    ) ||
    recoveryCommands.some((command) =>
      /--auth-retry|browser cookies|auth import/.test(command),
    )
  )
    failures.push("Public API challenge suggested unsupported cookie recovery");
  const abort = new AbortController();
  abort.abort(new Error("cancelled credential recovery"));
  const cancelled = await run("recovery-cancel", "mcp", {
    signal: abort.signal,
  });
  if (
    !cancelled.error ||
    attempts.has("recovery-cancel") ||
    browserReads !== priorBrowserReads
  )
    failures.push("Pre-cancelled invocation acquired credentials");

  const publicDocument = await readEvidenceDocument(`${base}/public`);
  if (
    !publicDocument.content.includes("Research resource") ||
    browserReads !== priorBrowserReads ||
    requestCounts.get("/public") !== 1
  )
    failures.push("Public reader introduced browser or extra network work");
  saveCookies("127.0.0.1", { session: "127.0.0.1" });
  const persistedDocument = await readEvidenceDocument(`${base}/persisted`);
  if (
    !persistedDocument.content.includes("authenticated document") ||
    browserReads !== priorBrowserReads ||
    requestCounts.get("/persisted") !== 2
  )
    failures.push("Persisted URL credentials were not reused after rejection");
  saveCookies("127.0.0.1", { session: "expired" });
  const refreshedDocument = await readEvidenceDocument(`${base}/refreshed`);
  if (
    !refreshedDocument.content.includes("authenticated document") ||
    browserReads !== priorBrowserReads + 1 ||
    requestCounts.get("/refreshed") !== 3
  )
    failures.push("Expired URL credentials did not recover once from browser");
  const urlReader: AdapterManifest = {
    name: "url-recovery",
    type: AdapterType.WEB_API,
    commands: {
      read: {
        name: "read",
        strategy: Strategy.PUBLIC,
        operation_effect: "read",
        adapterArgs: [],
        func: async () => readEvidenceDocument(`${base}/optout`),
      },
    },
  };
  registerAdapter(urlReader);
  compileAll([...adapters, urlReader]);
  const readsBeforeOptout = browserReads;
  const optout = await run("url-recovery", "cli", { authRetry: false });
  if (
    !optout.error ||
    requestCounts.get("/optout") !== 1 ||
    browserReads !== readsBeforeOptout
  )
    failures.push("Kernel retry optout did not reach the URL reader");

  process.env.UNICLI_BROWSER_RUNTIME_DIR = runtime.runtimeRoot;
  await runtime.start();
  const browserReader = adapter("browser-recovery", "read", true);
  browserReader.commands.read.browser = true;
  browserReader.commands.read.browserSession = "auto";
  registerAdapter(browserReader);
  compileAll([...adapters, urlReader, browserReader]);
  const readsBeforeBrowser = browserReads;
  for (const authRetry of [undefined, true]) {
    const priorAttempts = attempts.get("browser-recovery") ?? 0;
    const scope = createBrowserInvocationScope({
      context: createBrowserInvocationContext({ transport: "mcp-stdio" }),
      provider: "managed",
      ephemeral: true,
    });
    const failedBrowserRead = await runBrowserInvocation(scope, () =>
      run("browser-recovery", "mcp", { authRetry }),
    );
    if (
      failedBrowserRead.error?.code !== "auth_required" ||
      attempts.get("browser-recovery") !== priorAttempts + 1 ||
      browserReads !== readsBeforeBrowser
    )
      failures.push(
        "Browser auth failure replayed a finalized turn or changed its original error",
      );
  }

  saveCookies("localhost", { session: "localhost" });
  const beforeRedirect = browserReads;
  const redirected = await readEvidenceDocument(`${base}/redirect-public`);
  if (
    !redirected.content.includes("Redirected private resource") ||
    redirected.source_url !== `${base}/redirect-public` ||
    new URL(redirected.url).hostname !== "localhost" ||
    browserReads !== beforeRedirect ||
    requestCounts.get("/redirect-public") !== 1 ||
    requestCounts.get("/target-auth") !== 2
  )
    failures.push(
      "Redirected credentials did not use the final source while preserving the original URL",
    );
  saveCookies("127.0.0.1", { session: "127.0.0.1" });
  const protectedRedirect = await readEvidenceDocument(`${base}/redirect-auth`);
  if (
    !protectedRedirect.content.includes("Redirected private resource") ||
    protectedRedirect.source_url !== `${base}/redirect-auth` ||
    crossOriginCookieForwarded ||
    requestCounts.get("/redirect-auth") !== 2 ||
    requestCounts.get("/target-cross-origin") !== 2
  )
    failures.push(
      "Cross-origin recovery forwarded the old credential or lost the new source",
    );

  let extractFailed = false;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/main.ts",
        "--no-auth-retry",
        "extract",
        `${base}/extract-optout`,
        "-f",
        "json",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, UNICLI_SKIP_UPDATE_CHECK: "1" },
        timeout: 30_000,
      },
    );
  } catch {
    extractFailed = true;
  }
  if (!extractFailed || requestCounts.get("/extract-optout") !== 1)
    failures.push("The real extract CLI ignored --no-auth-retry");

  await import("../../src/adapters/bilibili/compat.js");
  const bilibili = getAdapter("bilibili");
  if (!bilibili) throw new Error("Missing Bilibili command registration");
  compileAll([bilibili]);
  saveCookies("bilibili", { session: "expired" });
  const originalFetch = globalThis.fetch;
  const apiCookies: string[] = [];
  const readsBeforeApi = browserReads;
  // REASON: The upstream Bilibili API is an external boundary; run its real adapter, cookie acquisition, and kernel recovery.
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.bilibili.com")
      return originalFetch(input, init);
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    apiCookies.push(cookie);
    if (cookie !== "session=api.bilibili.com")
      return new Response("Sign in", { status: 401 });
    return Response.json({ data: { title: "Recovered video", bvid: "BV130" } });
  };
  try {
    const invocation = buildInvocation("cli", "bilibili", "video", {
      args: { bvid: "BV130" },
      source: "internal",
    });
    if (!invocation) throw new Error("Missing Bilibili video invocation");
    const video = await execute(invocation);
    if (
      video.error ||
      video.results[0]?.title !== "Recovered video" ||
      apiCookies.join(",") !== "session=expired,session=api.bilibili.com" ||
      browserReads !== readsBeforeApi + 1
    )
      failures.push(
        "Bilibili API recovery did not consume its refreshed host-scoped cookie",
      );
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log(
    JSON.stringify(
      {
        surfaces,
        browserReads,
        apiRequests: apiCookies.length,
        requests: Object.fromEntries(requestCounts),
        failures,
      },
      null,
      2,
    ),
  );
} finally {
  defaultCookieSources.readBrowser = originalBrowser;
  await runtime.cleanup();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
}
if (failures.length) process.exitCode = 1;
