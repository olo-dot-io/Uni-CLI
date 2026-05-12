import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import { parseDeepSeekConversationId } from "./web.js";

const CONVERSATION_ID = "749e6bbd-6a45-4440-beaa-ae5238bf06d8";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    insertText: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
  };
}

describe("deepseek agent-facing web commands", () => {
  it("validates conversation IDs and URLs", () => {
    expect(parseDeepSeekConversationId(CONVERSATION_ID.toUpperCase())).toBe(
      CONVERSATION_ID,
    );
    expect(
      parseDeepSeekConversationId(
        `https://chat.deepseek.com/a/chat/s/${CONVERSATION_ID}`,
      ),
    ).toBe(CONVERSATION_ID);
    expect(() => parseDeepSeekConversationId("not-a-uuid")).toThrow(
      "Invalid DeepSeek",
    );
  });

  it("reads a specific conversation detail", async () => {
    const command = resolveCommand("deepseek", "detail")?.command;
    expect(command?.func).toBeTypeOf("function");
    const page = pageMock([[{ index: 1, role: "assistant", text: "Answer" }]]);
    const result = await command!.func!(page, { id: CONVERSATION_ID });
    expect(page.goto).toHaveBeenCalledWith(
      `https://chat.deepseek.com/a/chat/s/${CONVERSATION_ID}`,
      { settleMs: 1800 },
    );
    expect(result).toEqual([{ index: 1, role: "assistant", text: "Answer" }]);
  });

  it("fails closed when a detail conversation has no visible messages", async () => {
    const command = resolveCommand("deepseek", "detail")?.command;
    await expect(
      command!.func!(pageMock([[]]), { id: CONVERSATION_ID }),
    ).rejects.toThrow("No visible DeepSeek messages");
  });

  it("sends text to a specific conversation", async () => {
    const command = resolveCommand("deepseek", "send")?.command;
    expect(command?.func).toBeTypeOf("function");
    const page = pageMock([]);
    const result = await command!.func!(page, {
      id: CONVERSATION_ID,
      prompt: "hello",
    });
    expect(page.goto).toHaveBeenCalledWith(
      `https://chat.deepseek.com/a/chat/s/${CONVERSATION_ID}`,
      { settleMs: 1800 },
    );
    expect(page.click).toHaveBeenCalled();
    expect(page.insertText).toHaveBeenCalledWith("hello");
    expect(page.press).toHaveBeenCalledWith("Enter");
    expect(result).toEqual([{ status: "success", injectedText: "hello" }]);
  });
});
