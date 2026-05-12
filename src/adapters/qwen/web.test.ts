import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  formatQwenDate,
  mapQwenBubbles,
  mapQwenSessions,
  normalizeQwenBoolean,
  parseQwenSessionId,
  qwenHtmlToMarkdown,
} from "./web.js";

const SESSION_ID = "abcd1234ef567890abcd1234ef567890";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
  };
}

describe("qwen agent-facing web commands", () => {
  it("validates session ids and maps helper rows", () => {
    expect(parseQwenSessionId(SESSION_ID.toUpperCase())).toBe(SESSION_ID);
    expect(
      parseQwenSessionId(`https://www.qianwen.com/chat/${SESSION_ID}`),
    ).toBe(SESSION_ID);
    expect(() => parseQwenSessionId(`${SESSION_ID}f`)).toThrow("Invalid Qwen");
    expect(normalizeQwenBoolean("yes")).toBe(true);
    expect(qwenHtmlToMarkdown("<p>A&nbsp;&lt;B&gt;</p>")).toBe("A <B>");
    expect(formatQwenDate(Date.UTC(2026, 4, 12, 8, 30))).toMatch(/^2026-05-12/);
    expect(
      mapQwenBubbles(
        [
          { role: "User", text: "Hi" },
          { role: "Assistant", text: "Hello", html: "<p>Hello&nbsp;AI</p>" },
        ],
        true,
      ),
    ).toEqual([
      { Role: "User", Text: "Hi" },
      { Role: "Assistant", Text: "Hello AI" },
    ]);
    expect(
      mapQwenSessions([{ id: SESSION_ID, title: " Chat ", updated_at: 0 }]),
    ).toEqual([
      {
        Index: 1,
        Title: "Chat",
        Updated: "",
        Url: `https://www.qianwen.com/chat/${SESSION_ID}`,
      },
    ]);
  });

  it("sends a Qwen prompt", async () => {
    const command = resolveCommand("qwen", "send")?.command;
    expect(command?.func).toBeTypeOf("function");
    const page = pageMock([
      "https://www.qianwen.com/",
      false,
      { ok: true, action: "click" },
    ]);
    const result = await command!.func!(page, { prompt: "hello" });
    expect(result).toEqual([{ Status: "sent", Prompt: "hello" }]);
  });

  it("reads current Qwen messages", async () => {
    const command = resolveCommand("qwen", "read")?.command;
    const page = pageMock([
      "https://www.qianwen.com/",
      false,
      [
        { id: "1-question", role: "User", text: "Hi" },
        { id: "1-answer", role: "Assistant", text: "Hello" },
      ],
    ]);
    const result = await command!.func!(page, {});
    expect(result).toEqual([
      { Role: "User", Text: "Hi" },
      { Role: "Assistant", Text: "Hello" },
    ]);
  });

  it("lists Qwen history through the session API", async () => {
    const command = resolveCommand("qwen", "history")?.command;
    const page = pageMock([
      "https://www.qianwen.com/",
      false,
      {
        ok: true,
        status: 200,
        body: { data: { list: [{ session_id: SESSION_ID, title: "Chat" }] } },
      },
    ]);
    const result = await command!.func!(page, { limit: 20 });
    expect(result).toEqual([
      {
        Index: 1,
        Title: "Chat",
        Updated: "",
        Url: `https://www.qianwen.com/chat/${SESSION_ID}`,
      },
    ]);
  });

  it("rejects invalid Qwen integer arguments instead of clamping", async () => {
    const command = resolveCommand("qwen", "history")?.command;
    await expect(command!.func!(pageMock([]), { limit: 101 })).rejects.toThrow(
      "Qwen history limit must be <= 100.",
    );
  });

  it("opens Qwen detail and polls for messages", async () => {
    const command = resolveCommand("qwen", "detail")?.command;
    const page = pageMock([
      false,
      [{ id: "1-answer", role: "Assistant", text: "Answer" }],
    ]);
    const result = await command!.func!(page, { id: SESSION_ID });
    expect(page.goto).toHaveBeenCalledWith(
      `https://www.qianwen.com/chat/${SESSION_ID}`,
      { waitUntil: "load", settleMs: 2500 },
    );
    expect(result).toEqual([{ Role: "Assistant", Text: "Answer" }]);
  });

  it("starts new Qwen chats and reports status", async () => {
    const newCommand = resolveCommand("qwen", "new")?.command;
    const newPage = pageMock([false, true]);
    expect(await newCommand!.func!(newPage, {})).toEqual([
      { Status: "New chat started" },
    ]);
    const statusCommand = resolveCommand("qwen", "status")?.command;
    const statusPage = pageMock([
      "https://www.qianwen.com/chat/abcd1234ef567890abcd1234ef567890",
      true,
      SESSION_ID,
      "Qwen3",
      `https://www.qianwen.com/chat/${SESSION_ID}`,
    ]);
    expect(await statusCommand!.func!(statusPage, {})).toEqual([
      {
        Status: "Connected",
        Login: "Yes",
        Model: "Qwen3",
        SessionId: SESSION_ID,
        Url: `https://www.qianwen.com/chat/${SESSION_ID}`,
      },
    ]);
  });

  it("supports image dry-run output after generated image wait", async () => {
    const command = resolveCommand("qwen", "image")?.command;
    const page = pageMock([
      "https://www.qianwen.com/",
      false,
      true,
      true,
      { ok: true, action: "click" },
      [{ id: "1-answer", role: "Assistant", text: "done" }],
      `https://www.qianwen.com/chat/${SESSION_ID}`,
    ]);
    const result = await command!.func!(page, {
      prompt: "draw a cat",
      sd: true,
    });
    expect(result).toEqual([
      {
        Status: "generated",
        File: null,
        Link: `https://www.qianwen.com/chat/${SESSION_ID}`,
      },
    ]);
  });
});
