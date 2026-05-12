import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  mapClaudeConversations,
  mapClaudeMessages,
  normalizeClaudeBoolean,
  parseClaudeConversationId,
  requireClaudePositiveInt,
  requireClaudePrompt,
} from "./web.js";

const CONVERSATION_ID = "123e4567-e89b-12d3-a456-426614174000";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
    insertText: vi.fn().mockResolvedValue(undefined),
    setFileInput: vi.fn().mockResolvedValue(undefined),
  };
}

describe("claude agent-facing web commands", () => {
  it("validates helper inputs and maps rows", () => {
    expect(normalizeClaudeBoolean(true)).toBe(true);
    expect(normalizeClaudeBoolean("true")).toBe(true);
    expect(normalizeClaudeBoolean("1")).toBe(false);
    expect(requireClaudePrompt(" hi ", "Claude ask")).toBe("hi");
    expect(() => requireClaudePrompt(" ", "Claude ask")).toThrow(
      "Claude ask prompt cannot be empty.",
    );
    expect(requireClaudePositiveInt("3", 20, "Claude history limit")).toBe(3);
    expect(() =>
      requireClaudePositiveInt(0, 20, "Claude history limit"),
    ).toThrow("Claude history limit must be a positive integer.");
    expect(parseClaudeConversationId(CONVERSATION_ID.toUpperCase())).toBe(
      CONVERSATION_ID,
    );
    expect(
      parseClaudeConversationId(`https://claude.ai/chat/${CONVERSATION_ID}`),
    ).toBe(CONVERSATION_ID);
    expect(() => parseClaudeConversationId("not-a-uuid")).toThrow(
      "Invalid Claude",
    );
    expect(
      mapClaudeMessages([
        { role: "user", text: "Hi" },
        { role: "assistant", text: "Hello" },
      ]),
    ).toEqual([
      { Index: 1, Role: "user", Text: "Hi" },
      { Index: 2, Role: "assistant", Text: "Hello" },
    ]);
    expect(
      mapClaudeConversations(
        [
          {
            Id: CONVERSATION_ID,
            Title: "",
            Url: `https://claude.ai/chat/${CONVERSATION_ID}`,
          },
        ],
        10,
      ),
    ).toEqual([
      {
        Index: 1,
        Id: CONVERSATION_ID,
        Title: "(untitled)",
        Url: `https://claude.ai/chat/${CONVERSATION_ID}`,
      },
    ]);
  });

  it("reads the current Claude conversation", async () => {
    const command = resolveCommand("claude", "read")?.command;
    const page = pageMock([
      `https://claude.ai/chat/${CONVERSATION_ID}`,
      {
        url: `https://claude.ai/chat/${CONVERSATION_ID}`,
        hasComposer: true,
        isLoggedIn: true,
      },
      [
        { role: "user", text: "Hi" },
        { role: "assistant", text: "Hello" },
      ],
    ]);
    await expect(command!.func!(page, {})).resolves.toEqual([
      { Index: 1, Role: "user", Text: "Hi" },
      { Index: 2, Role: "assistant", Text: "Hello" },
    ]);
  });

  it("lists Claude history from recents", async () => {
    const command = resolveCommand("claude", "history")?.command;
    const page = pageMock([
      "https://claude.ai/new",
      [
        {
          Id: CONVERSATION_ID,
          Title: "Chat",
          Url: `https://claude.ai/chat/${CONVERSATION_ID}`,
        },
      ],
      {
        url: "https://claude.ai/recents",
        hasComposer: false,
        isLoggedIn: true,
      },
    ]);
    await expect(command!.func!(page, { limit: 20 })).resolves.toEqual([
      {
        Index: 1,
        Id: CONVERSATION_ID,
        Title: "Chat",
        Url: `https://claude.ai/chat/${CONVERSATION_ID}`,
      },
    ]);
    expect(page.goto).toHaveBeenCalledWith("https://claude.ai/recents", {
      waitUntil: "load",
      settleMs: 2500,
    });
  });

  it("opens Claude detail and reads messages", async () => {
    const command = resolveCommand("claude", "detail")?.command;
    const page = pageMock([
      {
        url: `https://claude.ai/chat/${CONVERSATION_ID}`,
        hasComposer: false,
        isLoggedIn: true,
      },
      [{ role: "assistant", text: "Answer" }],
    ]);
    await expect(
      command!.func!(page, { id: CONVERSATION_ID }),
    ).resolves.toEqual([{ Index: 1, Role: "assistant", Text: "Answer" }]);
    expect(page.goto).toHaveBeenCalledWith(
      `https://claude.ai/chat/${CONVERSATION_ID}`,
      { waitUntil: "load", settleMs: 2500 },
    );
  });

  it("sends Claude prompts without waiting", async () => {
    const command = resolveCommand("claude", "send")?.command;
    const page = pageMock([
      "https://claude.ai/new",
      { url: "https://claude.ai/new", hasComposer: true, isLoggedIn: true },
      true,
      { ok: true, method: "send-button" },
    ]);
    await expect(command!.func!(page, { prompt: "hello" })).resolves.toEqual([
      { Status: "Success", SubmittedBy: "send-button", InjectedText: "hello" },
    ]);
    expect(page.insertText).toHaveBeenCalledWith("hello");
  });

  it("starts new Claude chats and reports status", async () => {
    const newCommand = resolveCommand("claude", "new")?.command;
    const newPage = pageMock([
      { url: "https://claude.ai/new", hasComposer: true, isLoggedIn: true },
    ]);
    await expect(newCommand!.func!(newPage, {})).resolves.toEqual([
      { Status: "New chat started" },
    ]);
    expect(newPage.goto).toHaveBeenCalledWith("https://claude.ai/new", {
      waitUntil: "load",
      settleMs: 2500,
    });

    const statusCommand = resolveCommand("claude", "status")?.command;
    const statusPage = pageMock([
      "https://claude.ai/new",
      { url: "https://claude.ai/new", hasComposer: true, isLoggedIn: true },
    ]);
    await expect(statusCommand!.func!(statusPage, {})).resolves.toEqual([
      { Status: "Connected", Login: "Yes", Url: "https://claude.ai/new" },
    ]);
  });

  it("asks Claude and waits for a stable response", async () => {
    const command = resolveCommand("claude", "ask")?.command;
    const page = pageMock([
      "https://claude.ai/new",
      { url: "https://claude.ai/new", hasComposer: true, isLoggedIn: true },
      "https://claude.ai/new",
      { ok: true },
      { ok: true },
      { ok: true },
      0,
      true,
      { ok: true, method: "send-button" },
      { count: 1, last: "answer", streaming: false },
      { count: 1, last: "answer", streaming: false },
      { count: 1, last: "answer", streaming: false },
      { count: 1, last: "answer", streaming: false },
    ]);
    await expect(
      command!.func!(page, { prompt: "hello", timeout: 120 }),
    ).resolves.toEqual([{ response: "answer" }]);
    expect(page.insertText).toHaveBeenCalledWith("hello");
  });
});
