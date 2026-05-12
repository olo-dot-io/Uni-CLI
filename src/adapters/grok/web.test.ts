import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  grokHtmlToMarkdown,
  mapGrokBubbles,
  mapGrokSessions,
  normalizeGrokBoolean,
  parseGrokSessionId,
  pickLatestGrokImages,
} from "./web.js";

const SESSION_ID = "7c4197f2-10a1-4ebb-a84a-fea89f4f1d06";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
  };
}

describe("grok agent-facing web commands", () => {
  it("validates ids and maps helper rows", () => {
    expect(parseGrokSessionId(SESSION_ID.toUpperCase())).toBe(SESSION_ID);
    expect(parseGrokSessionId(`https://grok.com/c/${SESSION_ID}`)).toBe(
      SESSION_ID,
    );
    expect(() => parseGrokSessionId("not-a-uuid")).toThrow("Invalid Grok");
    expect(normalizeGrokBoolean("on")).toBe(true);
    expect(grokHtmlToMarkdown("<p>A&nbsp;&lt;B&gt;</p>")).toBe("A <B>");
    expect(
      mapGrokBubbles(
        [
          { id: "1-user", role: "User", text: "Hi" },
          {
            id: "1-assistant",
            role: "Assistant",
            text: "Hello",
            html: "<p>Hello&nbsp;AI</p>",
          },
        ],
        true,
      ),
    ).toEqual([
      { Role: "User", Text: "Hi" },
      { Role: "Assistant", Text: "Hello AI" },
    ]);
    expect(mapGrokSessions([{ id: SESSION_ID, title: "" }])).toEqual([
      {
        Index: 1,
        Title: "(untitled)",
        Url: `https://grok.com/c/${SESSION_ID}`,
      },
    ]);
    expect(
      pickLatestGrokImages(
        [[], [{ src: "https://assets.grok.com/a.jpg", w: 512, h: 512 }]],
        1,
      ),
    ).toEqual([{ src: "https://assets.grok.com/a.jpg", w: 512, h: 512 }]);
  });

  it("reads current Grok messages", async () => {
    const command = resolveCommand("grok", "read")?.command;
    const page = pageMock([
      "https://grok.com/",
      [
        { id: "1-user", role: "User", text: "Hi" },
        { id: "1-assistant", role: "Assistant", text: "Hello" },
      ],
    ]);
    const result = await command!.func!(page, {});
    expect(result).toEqual([
      { Role: "User", Text: "Hi" },
      { Role: "Assistant", Text: "Hello" },
    ]);
  });

  it("lists Grok history from the sidebar", async () => {
    const command = resolveCommand("grok", "history")?.command;
    const page = pageMock([
      "https://grok.com/",
      true,
      [{ id: SESSION_ID, title: "Chat" }],
    ]);
    const result = await command!.func!(page, { limit: 20 });
    expect(result).toEqual([
      {
        Index: 1,
        Title: "Chat",
        Url: `https://grok.com/c/${SESSION_ID}`,
      },
    ]);
  });

  it("rejects invalid Grok integer arguments instead of clamping", async () => {
    const command = resolveCommand("grok", "history")?.command;
    await expect(command!.func!(pageMock([]), { limit: 101 })).rejects.toThrow(
      "Grok history limit must be <= 100.",
    );
  });

  it("opens Grok detail and polls for messages", async () => {
    const command = resolveCommand("grok", "detail")?.command;
    const page = pageMock([
      [{ id: "1-assistant", role: "Assistant", text: "Answer" }],
    ]);
    const result = await command!.func!(page, { id: SESSION_ID });
    expect(page.goto).toHaveBeenCalledWith(`https://grok.com/c/${SESSION_ID}`, {
      waitUntil: "load",
      settleMs: 2500,
    });
    expect(result).toEqual([{ Role: "Assistant", Text: "Answer" }]);
  });

  it("sends prompts and starts new chats", async () => {
    const sendCommand = resolveCommand("grok", "send")?.command;
    const sendPage = pageMock(["https://grok.com/", { ok: true }]);
    expect(await sendCommand!.func!(sendPage, { prompt: "hello" })).toEqual([
      { Status: "sent", Prompt: "hello" },
    ]);

    const newCommand = resolveCommand("grok", "new")?.command;
    const newPage = pageMock([]);
    expect(await newCommand!.func!(newPage, {})).toEqual([
      { Status: "New chat started" },
    ]);
    expect(newPage.goto).toHaveBeenCalledWith("https://grok.com/", {
      waitUntil: "load",
      settleMs: 2500,
    });
  });

  it("reports Grok status", async () => {
    const command = resolveCommand("grok", "status")?.command;
    const page = pageMock([
      `https://grok.com/c/${SESSION_ID}`,
      true,
      `https://grok.com/c/${SESSION_ID}`,
      "Grok 4",
      `https://grok.com/c/${SESSION_ID}`,
    ]);
    expect(await command!.func!(page, {})).toEqual([
      {
        Status: "Connected",
        Login: "Yes",
        Model: "Grok 4",
        SessionId: SESSION_ID,
        Url: `https://grok.com/c/${SESSION_ID}`,
      },
    ]);
  });

  it("returns generated Grok image rows after stable reads", async () => {
    const command = resolveCommand("grok", "image")?.command;
    const images = [
      [{ src: "https://assets.grok.com/a.jpg", w: 1024, h: 1024 }],
    ];
    const page = pageMock([
      "https://grok.com/",
      [],
      { ok: true },
      images,
      images,
      images,
    ]);
    const result = await command!.func!(page, {
      prompt: "draw a rocket",
      timeout: 10,
      count: 1,
    });
    expect(result).toEqual([
      {
        url: "https://assets.grok.com/a.jpg",
        width: 1024,
        height: 1024,
        path: "",
      },
    ]);
  });
});
