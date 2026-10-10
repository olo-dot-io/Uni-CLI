import { createServer, type Server } from "node:http";
import { HttpTransport } from "../../src/transport/adapters/http.js";
import { createTransportBus } from "../../src/transport/bus.js";
import { isOperationOutcomeAmbiguousError } from "../../src/transport/contained-process.js";
import { MAX_TEXT_RESOURCE_BYTES } from "../../src/engine/steps/fetch-text.js";

const outcomes: Array<{ scenario: string; passed: boolean }> = [];
const record = (scenario: string, passed: boolean) =>
  outcomes.push({ scenario, passed });
const previousAllowLocal = process.env.UNICLI_ALLOW_LOCAL;
process.env.UNICLI_ALLOW_LOCAL = "1";
const requestCounts = new Map<string, number>();
let value = "initial";
let readStarted: () => void;
let writeStarted: () => void;
const reading = new Promise<void>((resolve) => {
  readStarted = resolve;
});
const writing = new Promise<void>((resolve) => {
  writeStarted = resolve;
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Scenario server did not receive a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

const redirected = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      cookie: request.headers.cookie ?? null,
      authorization: request.headers.authorization ?? null,
      agent: request.headers["user-agent"] ?? null,
    }),
  );
});
const redirectedUrl = await listen(redirected);
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
  if (path === "/redirect") {
    response.writeHead(302, { location: redirectedUrl }).end();
    return;
  }
  if (path === "/loop") {
    response.writeHead(302, { location: "/loop" }).end();
    return;
  }
  if (path === "/access-check") {
    response
      .writeHead(Number(url.searchParams.get("status") ?? 200), {
        "cf-mitigated": "challenge",
        "content-type": "text/html",
      })
      .end(
        "<h1>Confirm access</h1><p>This resource requires verification.</p>",
      );
    return;
  }
  if (path === "/rate") {
    response.writeHead(429, { "retry-after": "1" }).end("Wait");
    return;
  }
  if (path === "/pdf") {
    response
      .writeHead(200, { "content-type": "application/pdf" })
      .end("%PDF-1.4 binary fixture");
    return;
  }
  if (path === "/oversized") {
    response
      .writeHead(200, {
        "content-type": "text/plain",
        "content-length": MAX_TEXT_RESOURCE_BYTES + 1,
      })
      .end("oversized");
    return;
  }
  if (path === "/markdown") {
    response
      .writeHead(200, { "content-type": "text/markdown" })
      .end(
        "# Native Markdown\n\n`<component>` and [a_b](https://example.com/a_b)",
      );
    return;
  }
  if (path === "/invalid-json") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end("invalid JSON");
    return;
  }
  if (path === "/interrupted") {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": 100,
    });
    response.write('{"value":');
    const timer = setTimeout(() => response.destroy(), 10);
    response.once("close", () => clearTimeout(timer));
    return;
  }
  if (path === "/slow-read" || path === "/slow-write") {
    if (path === "/slow-write") {
      value = "accepted-write";
      writeStarted();
    } else {
      readStarted();
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"value":');
    const timer = setTimeout(
      () => response.end(JSON.stringify(value) + "}"),
      500,
    );
    response.once("close", () => clearTimeout(timer));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  if (request.method === "POST" || request.method === "PATCH") {
    try {
      value = JSON.parse(body).value;
    } catch {
      response.writeHead(400).end("Expected a JSON request body");
      return;
    }
  }
  if (path === "/interrupted-write") {
    response.writeHead(201, {
      "content-type": "application/json",
      "content-length": 100,
    });
    response.write('{"value":');
    const timer = setTimeout(() => response.destroy(), 10);
    response.once("close", () => clearTimeout(timer));
    return;
  }
  if (request.method === "DELETE") {
    value = "deleted";
    response.writeHead(204).end();
    return;
  }
  response.writeHead(request.method === "POST" ? 201 : 200, {
    "content-type": "application/json",
  });
  response.end(
    JSON.stringify({
      value,
      method: request.method,
      accept: request.headers.accept,
      query: url.searchParams.get("query"),
      contentType: request.headers["content-type"],
    }),
  );
});
const base = await listen(server);
const transport = new HttpTransport();

try {
  await transport.open({
    vars: {},
    bus: createTransportBus(),
    cookieHeader: "fixture-session=1",
  });
  const created = await transport.action<{
    value: string;
    method: string;
    accept: string;
  }>({
    kind: "fetch",
    params: {
      url: base,
      method: "post",
      body: { value: "created" },
      headers: { accept: "application/vnd.unicli.fixture+json" },
    },
  });
  record(
    "JSON creation preserves the server's authoritative receipt",
    created.ok &&
      created.data.value === "created" &&
      created.data.method === "POST" &&
      created.effect_verdict?.status === "confirmed",
  );
  record(
    "Explicit headers override defaults independently of name casing",
    created.ok && created.data.accept === "application/vnd.unicli.fixture+json",
  );
  const snapshot = await transport.snapshot();
  record(
    "Snapshot exposes the completed creation envelope",
    JSON.parse(snapshot.data.toString()).data?.value === "created",
  );

  const changed = await transport.action<string>({
    kind: "fetch_text",
    params: {
      url: base,
      method: "PATCH",
      params: { query: "space & punctuation" },
      body: { value: "changed" },
    },
  });
  const changedData = changed.ok ? JSON.parse(changed.data) : undefined;
  record(
    "Text requests send JSON bodies and encoded query parameters",
    changed.ok &&
      changedData.value === "changed" &&
      changedData.query === "space & punctuation" &&
      changedData.contentType === "application/json",
  );
  record(
    "Generic mutation responses retain their unverifiable effect",
    changed.effect_verdict?.status === "unverifiable",
  );

  for (const kind of ["fetch", "fetch_text"]) {
    const redirect = await transport.action<
      string | { cookie: null; authorization: null; agent: string }
    >({
      kind,
      params: {
        url: `${base}/redirect`,
        headers: { Authorization: "Bearer fixture" },
      },
    });
    const data = redirect.ok
      ? typeof redirect.data === "string"
        ? JSON.parse(redirect.data)
        : redirect.data
      : undefined;
    record(
      `${kind} delegates cross-origin redirect handling to the shared reader`,
      data?.cookie === null &&
        data?.authorization === null &&
        typeof data?.agent === "string",
    );

    for (const status of [200, 403]) {
      const challenge = await transport.action({
        kind,
        params: { url: `${base}/access-check?status=${status}` },
      });
      record(
        `${kind} reports challenged HTTP ${status} as verification required`,
        !challenge.ok &&
          challenge.error.exit_code === 77 &&
          challenge.error.retryable === false &&
          /challenge|verification/i.test(challenge.error.reason) &&
          /official API|browser reader/i.test(challenge.error.suggestion) &&
          /adapter that declares and consumes/i.test(
            challenge.error.suggestion,
          ),
      );
    }
    for (const [path, reason] of [
      ["pdf", /non-text content/i],
      ["oversized", /exceeds.*text limit/i],
    ] as const) {
      const rejected = await transport.action({
        kind,
        params: { url: `${base}/${path}` },
      });
      record(
        `${kind} rejects ${path} content before parsing`,
        !rejected.ok &&
          !rejected.error.retryable &&
          reason.test(rejected.error.reason),
      );
    }
    const before = requestCounts.get("/rate") ?? 0;
    const rate = await transport.action({
      kind,
      params: { url: `${base}/rate` },
    });
    record(
      `${kind} preserves Retry-After guidance without introducing transport retries`,
      !rate.ok &&
        rate.error.exit_code === 75 &&
        rate.error.retryable &&
        /Retry-After/i.test(rate.error.suggestion) &&
        requestCounts.get("/rate") === before + 1,
    );
    const interrupted = await transport.action({
      kind,
      params: { url: `${base}/interrupted` },
    });
    record(
      `${kind} classifies an interrupted response body as a network failure`,
      !interrupted.ok &&
        interrupted.error.exit_code === 75 &&
        interrupted.error.retryable,
    );

    const writesBefore = requestCounts.get("/interrupted-write") ?? 0;
    const acceptedValue = `accepted-${kind}`;
    const interruptedWrite = await transport
      .action({
        kind,
        params: {
          url: `${base}/interrupted-write`,
          method: "POST",
          body: { value: acceptedValue },
        },
      })
      .catch((error) => error);
    record(
      `${kind} preserves accepted-write ambiguity and status after a body failure`,
      isOperationOutcomeAmbiguousError(interruptedWrite) &&
        interruptedWrite.cause?.detail?.statusCode === 201 &&
        requestCounts.get("/interrupted-write") === writesBefore + 1,
    );
    const acceptedState = await transport.action<{ value: string }>({
      kind: "fetch",
      params: { url: base },
    });
    record(
      `${kind} reads the accepted state after a failed write response`,
      acceptedState.ok && acceptedState.data.value === acceptedValue,
    );
  }
  const native = await transport.action<string>({
    kind: "fetch_text",
    params: { url: `${base}/markdown` },
  });
  record(
    "Native Markdown remains byte-for-byte textual content",
    native.ok &&
      native.data ===
        "# Native Markdown\n\n`<component>` and [a_b](https://example.com/a_b)",
  );
  const malformed = await transport.action({
    kind: "fetch",
    params: { url: `${base}/invalid-json` },
  });
  record(
    "Malformed JSON remains a non-retryable parse failure",
    !malformed.ok &&
      !malformed.error.retryable &&
      /JSON/.test(malformed.error.reason),
  );
  const loop = await transport.action({
    kind: "fetch_text",
    params: { url: `${base}/loop` },
  });
  record(
    "Redirect loops stop at the existing redirect bound",
    !loop.ok && !loop.error.retryable && requestCounts.get("/loop") === 11,
  );

  const readController = new AbortController();
  const readCancellation = new Error("cancel scenario read");
  const readResult = transport
    .action({
      kind: "fetch_text",
      params: { url: `${base}/slow-read` },
      signal: readController.signal,
    })
    .catch((error) => error);
  await reading;
  readController.abort(readCancellation);
  record(
    "Read cancellation retains the exact caller reason",
    (await readResult) === readCancellation,
  );

  const writeController = new AbortController();
  const writeCancellation = new Error("cancel accepted scenario write");
  const writeResult = transport
    .action({
      kind: "fetch",
      params: {
        url: `${base}/slow-write`,
        method: "POST",
        body: { value: "write" },
      },
      signal: writeController.signal,
    })
    .catch((error) => error);
  await writing;
  writeController.abort(writeCancellation);
  const writeError = await writeResult;
  record(
    "Accepted mutation cancellation remains outcome-ambiguous",
    isOperationOutcomeAmbiguousError(writeError) &&
      writeError.cancellationReason === writeCancellation,
  );

  await transport.close();
  await transport.open({ vars: {}, bus: createTransportBus() });
  const recovered = await transport.action<{ value: string }>({
    kind: "fetch",
    params: { url: base },
  });
  record(
    "Reopening and reading exposes the accepted mutation",
    recovered.ok && recovered.data.value === "accepted-write",
  );
  const removed = await transport.action({
    kind: "fetch_text",
    params: { url: base, method: "DELETE" },
  });
  record(
    "Authoritative empty text responses confirm deletion",
    removed.ok &&
      removed.data === "" &&
      removed.effect_verdict?.status === "confirmed",
  );
} finally {
  await transport.close();
  for (const fixture of [server, redirected]) {
    fixture.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (previousAllowLocal === undefined) delete process.env.UNICLI_ALLOW_LOCAL;
  else process.env.UNICLI_ALLOW_LOCAL = previousAllowLocal;
}

console.log(JSON.stringify({ scenarios: outcomes.length, outcomes }, null, 2));
if (outcomes.some((outcome) => !outcome.passed)) process.exitCode = 1;
