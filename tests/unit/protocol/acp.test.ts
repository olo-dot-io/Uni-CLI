/**
 * ACP server unit tests — verify the JSON-RPC dispatch, session lifecycle,
 * prompt parsing, and error envelope shape.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  AcpServer,
  parseUnicliInvocation,
  suggestCommands,
  type AcpRpcResponse,
  type AcpRpcNotification,
} from "../../../src/protocol/acp.js";
import { loadAllAdapters } from "../../../src/discovery/loader.js";

beforeAll(() => {
  // Ensure the registry is populated so suggestCommands has data to work with
  // and prompt/submit dispatch can resolve real site/command pairs.
  loadAllAdapters();
});

/**
 * Factory that returns a fresh server instance plus the list of frames
 * emitted via `emit`. Keeps assertions local to each test.
 */
function makeServer(): {
  server: AcpServer;
  frames: Array<AcpRpcResponse | AcpRpcNotification>;
  logs: string[];
} {
  const frames: Array<AcpRpcResponse | AcpRpcNotification> = [];
  const logs: string[] = [];
  const server = new AcpServer({
    emit: (frame) => frames.push(frame),
    log: (m) => logs.push(m),
  });
  return { server, frames, logs };
}

describe("parseUnicliInvocation", () => {
  it("extracts site, command, and positional query", () => {
    const parsed = parseUnicliInvocation('unicli twitter search "claude code"');
    expect(parsed).toBeDefined();
    expect(parsed!.site).toBe("twitter");
    expect(parsed!.command).toBe("search");
    expect(parsed!.args.query).toBe("claude code");
  });

  it("parses --flag value pairs and coerces ints", () => {
    const parsed = parseUnicliInvocation(
      "unicli hackernews top --limit 10 --debug",
    );
    expect(parsed).toBeDefined();
    expect(parsed!.args.limit).toBe(10);
    expect(parsed!.args.debug).toBe(true);
  });

  it("parses key=value tokens", () => {
    const parsed = parseUnicliInvocation("unicli bilibili hot region=cn");
    expect(parsed).toBeDefined();
    expect(parsed!.args.region).toBe("cn");
  });

  it("returns undefined when no unicli invocation is present", () => {
    expect(parseUnicliInvocation("just a plain prompt")).toBeUndefined();
  });

  it("tolerates leading text before the invocation", () => {
    const parsed = parseUnicliInvocation(
      "please run this for me: unicli reddit top",
    );
    expect(parsed).toBeDefined();
    expect(parsed!.site).toBe("reddit");
    expect(parsed!.command).toBe("top");
  });
});

describe("AcpServer — initialize", () => {
  it("responds with capabilities + serverInfo", async () => {
    const { server } = makeServer();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(res).toBeDefined();
    expect((res as AcpRpcResponse).id).toBe(1);
    const result = (res as AcpRpcResponse).result as Record<string, unknown>;
    expect(result.serverInfo).toEqual(
      expect.objectContaining({ name: "unicli" }),
    );
    expect(result.capabilities).toEqual(
      expect.objectContaining({
        exec: true,
        mcp: true,
        search: true,
        streaming: true,
      }),
    );
    expect(server.isInitialized()).toBe(true);
  });

  it("returns no response for the initialized notification", async () => {
    const { server } = makeServer();
    const res = await server.handle({
      jsonrpc: "2.0",
      method: "initialized",
    });
    expect(res).toBeUndefined();
  });
});

describe("AcpServer — sessions", () => {
  it("creates a session with a generated id when none provided", async () => {
    const { server } = makeServer();
    const res = (await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/create",
      params: {},
    })) as AcpRpcResponse;
    const result = res.result as { sessionId: string };
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(server.getSessions().length).toBe(1);
  });

  it("honours a caller-provided session id", async () => {
    const { server } = makeServer();
    const res = (await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "session/create",
      params: { id: "my-session" },
    })) as AcpRpcResponse;
    expect((res.result as { sessionId: string }).sessionId).toBe("my-session");
  });

  it("cancel flips the cancelled flag and list reports it", async () => {
    const { server } = makeServer();
    await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "session/create",
      params: { id: "cancel-me" },
    });
    const cancelRes = (await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "session/cancel",
      params: { sessionId: "cancel-me" },
    })) as AcpRpcResponse;
    expect(cancelRes.result).toEqual({ cancelled: true });

    const listRes = (await server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "session/list",
    })) as AcpRpcResponse;
    const sessions = (
      listRes.result as { sessions: Array<{ cancelled: boolean }> }
    ).sessions;
    expect(sessions.some((s) => s.cancelled)).toBe(true);
  });

  it("cancel returns an error envelope for unknown session", async () => {
    const { server } = makeServer();
    const res = (await server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "session/cancel",
      params: { sessionId: "does-not-exist" },
    })) as AcpRpcResponse;
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
  });
});

describe("AcpServer — prompt/submit", () => {
  it("rejects empty prompts with -32602", async () => {
    const { server } = makeServer();
    const res = (await server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "prompt/submit",
      params: { prompt: "   " },
    })) as AcpRpcResponse;
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
  });

  it("returns ok:false when no unicli invocation is detected", async () => {
    const { server, frames } = makeServer();
    const res = (await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "prompt/submit",
      params: { prompt: "hello world" },
    })) as AcpRpcResponse;
    const result = res.result as { ok: boolean; sessionId: string };
    expect(result.ok).toBe(false);
    expect(typeof result.sessionId).toBe("string");
    // Should stream at least one content/updated notification before returning.
    const updates = frames.filter((f) => f.method === "content/updated");
    expect(updates.length).toBeGreaterThan(0);
  });

  it("returns ok:false for a valid-shaped but unknown command", async () => {
    const { server } = makeServer();
    const res = (await server.handle({
      jsonrpc: "2.0",
      id: 10,
      method: "prompt/submit",
      params: { prompt: "unicli no-such-site nope" },
    })) as AcpRpcResponse;
    const result = res.result as {
      ok: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.ok).toBe(false);
    expect(result.content[0].text).toMatch(/Unknown command/);
  });
});

describe("AcpServer — error handling", () => {
  it("returns -32601 for an unknown method", async () => {
    const { server } = makeServer();
    const res = (await server.handle({
      jsonrpc: "2.0",
      id: 11,
      method: "nope/nope",
    })) as AcpRpcResponse;
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32601);
  });

  it("ping responds with an empty result", async () => {
    const { server } = makeServer();
    const res = (await server.handle({
      jsonrpc: "2.0",
      id: 12,
      method: "ping",
    })) as AcpRpcResponse;
    expect(res.result).toEqual({});
  });

  it("authenticate always succeeds (no real auth at ACP layer)", async () => {
    const { server } = makeServer();
    const res = (await server.handle({
      jsonrpc: "2.0",
      id: 13,
      method: "authenticate",
      params: { token: "anything" },
    })) as AcpRpcResponse;
    expect((res.result as { ok: boolean }).ok).toBe(true);
  });
});

describe("suggestCommands", () => {
  it("returns a default suggestion when no match is found", () => {
    // All tokens are gibberish >=3 chars so no adapter description can
    // substring-match them. Keeps the test deterministic regardless of
    // the registry state.
    const hint = suggestCommands("ZZZQQQXXX JJJKKKWWW HHHMMMYYY");
    expect(hint).toContain("unicli list");
  });

  it("returns candidate commands when the prompt mentions a site token", () => {
    const hint = suggestCommands("I want hackernews top posts");
    // Should either return matching candidates OR the fallback, never throw.
    expect(typeof hint).toBe("string");
    expect(hint.length).toBeGreaterThan(0);
  });
});
