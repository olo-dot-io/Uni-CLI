import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  mapYuanbaoBubbles,
  mapYuanbaoSessions,
  parseYuanbaoSessionId,
  yuanbaoHtmlToMarkdown,
} from "./web.js";

const SESSION = "agent_123/749e6bbd-6a45-4440-beaa-ae5238bf06d8";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
  };
}

describe("yuanbao agent-facing web commands", () => {
  it("validates complete Yuanbao session references", () => {
    expect(parseYuanbaoSessionId(SESSION)).toEqual({
      agentId: "agent_123",
      convId: "749e6bbd-6a45-4440-beaa-ae5238bf06d8",
    });
    expect(
      parseYuanbaoSessionId(`https://yuanbao.tencent.com/chat/${SESSION}`),
    ).toEqual({
      agentId: "agent_123",
      convId: "749e6bbd-6a45-4440-beaa-ae5238bf06d8",
    });
    expect(() =>
      parseYuanbaoSessionId("749e6bbd-6a45-4440-beaa-ae5238bf06d8"),
    ).toThrow("UUID alone is not enough");
  });

  it("maps Yuanbao bubbles and sessions to stable columns", () => {
    expect(yuanbaoHtmlToMarkdown("<p>A&nbsp;&lt;B&gt;</p>")).toBe("A <B>");
    expect(
      mapYuanbaoBubbles([
        { role: "User", text: "Hi" },
        { role: "Assistant", text: "Hello", html: "<p>Hello&nbsp;AI</p>" },
      ]),
    ).toEqual([
      { Role: "User", Text: "Hi" },
      { Role: "Assistant", Text: "Hello AI" },
    ]);
    expect(
      mapYuanbaoSessions([
        {
          cid: "749e6bbd-6a45-4440-beaa-ae5238bf06d8",
          agentId: "agent_123",
          title: " Session ",
        },
      ]),
    ).toEqual([
      {
        Index: 1,
        Title: "Session",
        AgentId: "agent_123",
        SessionId: "749e6bbd-6a45-4440-beaa-ae5238bf06d8",
        Url: "https://yuanbao.tencent.com/chat/agent_123/749e6bbd-6a45-4440-beaa-ae5238bf06d8",
      },
    ]);
  });

  it("reads current conversation messages", async () => {
    const command = resolveCommand("yuanbao", "read")?.command;
    expect(command?.func).toBeTypeOf("function");
    const page = pageMock([
      "https://yuanbao.tencent.com/chat",
      false,
      [{ role: "Assistant", text: "Answer" }],
    ]);
    const result = await command!.func!(page, {});
    expect(result).toEqual([{ Role: "Assistant", Text: "Answer" }]);
  });

  it("lists Yuanbao history", async () => {
    const command = resolveCommand("yuanbao", "history")?.command;
    const page = pageMock([
      "https://yuanbao.tencent.com/chat",
      false,
      [
        {
          cid: "749e6bbd-6a45-4440-beaa-ae5238bf06d8",
          agentId: "agent_123",
          title: "Session",
        },
      ],
    ]);
    const result = await command!.func!(page, { limit: 5 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ Title: "Session" });
  });

  it("opens detail URLs and polls for messages", async () => {
    const command = resolveCommand("yuanbao", "detail")?.command;
    const page = pageMock([false, [{ role: "User", text: "Prompt" }]]);
    const result = await command!.func!(page, { id: SESSION });
    expect(page.goto).toHaveBeenCalledWith(
      "https://yuanbao.tencent.com/chat/agent_123/749e6bbd-6a45-4440-beaa-ae5238bf06d8",
      { waitUntil: "load", settleMs: 2500 },
    );
    expect(result).toEqual([{ Role: "User", Text: "Prompt" }]);
  });

  it("sends Yuanbao prompts and reports status", async () => {
    const command = resolveCommand("yuanbao", "send")?.command;
    const page = pageMock([
      "https://yuanbao.tencent.com/chat",
      false,
      { ok: true, action: "click" },
    ]);
    const result = await command!.func!(page, { prompt: "hello" });
    expect(result).toEqual([{ Status: "sent", Prompt: "hello" }]);
  });

  it("reports Yuanbao status", async () => {
    const command = resolveCommand("yuanbao", "status")?.command;
    const page = pageMock([
      "https://yuanbao.tencent.com/chat/agent_123/749e6bbd-6a45-4440-beaa-ae5238bf06d8",
      false,
      {
        agentId: "agent_123",
        convId: "749e6bbd-6a45-4440-beaa-ae5238bf06d8",
      },
      { label: "Hunyuan", modelId: "hunyuan" },
      "https://yuanbao.tencent.com/chat/agent_123/749e6bbd-6a45-4440-beaa-ae5238bf06d8",
    ]);
    const result = await command!.func!(page, {});
    expect(result).toEqual([
      {
        Status: "Connected",
        Login: "Yes",
        Model: "Hunyuan",
        ModelId: "hunyuan",
        AgentId: "agent_123",
        SessionId: "749e6bbd-6a45-4440-beaa-ae5238bf06d8",
        Url: "https://yuanbao.tencent.com/chat/agent_123/749e6bbd-6a45-4440-beaa-ae5238bf06d8",
      },
    ]);
  });
});
