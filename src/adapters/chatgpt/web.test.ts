import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  chatGptHtmlToMarkdown,
  mapChatGptConversations,
  mapChatGptMessages,
  normalizeChatGptBoolean,
  parseChatGptConversationId,
} from "./web.js";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
  };
}

describe("chatgpt agent-facing web readers", () => {
  it("validates conversation ids and boolean flags", () => {
    expect(parseChatGptConversationId(" abcDEF_12345 ")).toBe("abcDEF_12345");
    expect(
      parseChatGptConversationId("https://chatgpt.com/c/abcDEF_12345"),
    ).toBe("abcDEF_12345");
    expect(() => parseChatGptConversationId("https://chatgpt.com/")).toThrow(
      "conversation id",
    );
    expect(normalizeChatGptBoolean("yes")).toBe(true);
    expect(normalizeChatGptBoolean(undefined, true)).toBe(true);
  });

  it("maps conversations and messages to stable columns", () => {
    expect(
      mapChatGptConversations([
        { Id: "c1", Title: " First ", Url: "https://chatgpt.com/c/c1" },
        { Id: "", Title: "skip", Url: "" },
      ]),
    ).toEqual([
      {
        Index: 1,
        Id: "c1",
        Title: "First",
        Url: "https://chatgpt.com/c/c1",
      },
    ]);
    expect(chatGptHtmlToMarkdown("<p>A&nbsp;&lt;B&gt;</p>")).toBe("A <B>");
    expect(
      mapChatGptMessages(
        [
          { role: "user", text: "Hi" },
          { role: "assistant", text: "Hello", html: "<p>Hello&nbsp;AI</p>" },
        ],
        true,
      ),
    ).toEqual([
      { Index: 1, Role: "User", Text: "Hi" },
      { Index: 2, Role: "Assistant", Text: "Hello AI" },
    ]);
  });

  it("lists visible ChatGPT web history", async () => {
    const command = resolveCommand("chatgpt", "history")?.command;
    expect(command?.func).toBeTypeOf("function");
    const page = pageMock([
      true,
      [
        {
          Id: "c1",
          Title: "Conversation",
          Url: "https://chatgpt.com/c/c1",
        },
      ],
    ]);
    const result = await command!.func!(page, { limit: 10 });
    expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com", {
      settleMs: 2000,
    });
    expect(result).toEqual([
      {
        Index: 1,
        Id: "c1",
        Title: "Conversation",
        Url: "https://chatgpt.com/c/c1",
      },
    ]);
  });

  it("opens a ChatGPT conversation detail and reads messages", async () => {
    const command = resolveCommand("chatgpt", "detail")?.command;
    expect(command?.func).toBeTypeOf("function");
    const page = pageMock([
      [
        { role: "user", text: "Prompt" },
        { role: "assistant", text: "Answer", html: "<p>Answer</p>" },
      ],
    ]);
    const result = await command!.func!(page, {
      id: "abcDEF_12345",
      markdown: true,
    });
    expect(page.goto).toHaveBeenCalledWith(
      "https://chatgpt.com/c/abcDEF_12345",
      { settleMs: 2000 },
    );
    expect(result).toEqual([
      { Index: 1, Role: "User", Text: "Prompt" },
      { Index: 2, Role: "Assistant", Text: "Answer" },
    ]);
  });

  it("fails closed when history or detail has no rows", async () => {
    const history = resolveCommand("chatgpt", "history")?.command;
    await expect(history!.func!(pageMock([false, []]), {})).rejects.toThrow(
      "No ChatGPT conversation links",
    );
    const detail = resolveCommand("chatgpt", "detail")?.command;
    await expect(
      detail!.func!(pageMock([[]]), { id: "abcDEF_12345" }),
    ).rejects.toThrow("No visible ChatGPT messages");
  });
});
