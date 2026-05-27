import { describe, expect, it } from "vitest";

import { resolveCommand } from "../../registry.js";
import {
  buildTwitterTweetExtractionScript,
  extractTweets,
} from "./lists-extra.js";
import type { IPage } from "../../types.js";

class FakeTwitterPage implements Partial<IPage> {
  public readonly navigatedUrls: string[] = [];
  public autoScrollCalls = 0;
  private evaluateCalls = 0;

  async goto(url: string): Promise<void> {
    this.navigatedUrls.push(url);
  }

  async wait(): Promise<void> {}

  async autoScroll(): Promise<void> {
    this.autoScrollCalls += 1;
  }

  async evaluate(): Promise<unknown> {
    this.evaluateCalls += 1;
    if (this.evaluateCalls === 1) {
      return {
        url: this.navigatedUrls.at(-1),
        title: "X",
        text: "alice: hello",
      };
    }
    return [
      {
        id: "1",
        author: "alice",
        text: "hello",
        likes: "2",
        retweets: "3",
        views: "4",
        url: "https://x.com/alice/status/1",
      },
    ];
  }
}

describe("twitter user timeline commands", () => {
  it("registers natural aliases for reading a user's tweets", () => {
    for (const name of ["tweets", "user-tweets", "user-timeline"]) {
      expect(resolveCommand("twitter", name)?.command.columns).toEqual([
        "id",
        "author",
        "text",
        "likes",
        "retweets",
        "views",
        "url",
      ]);
    }
  });

  it("normalizes @handles before navigating to a user timeline", async () => {
    // REASON: IPage is the browser boundary; this fake records navigation and
    // returns DOM-extracted rows without mocking owned adapter code.
    const page = new FakeTwitterPage() as IPage;

    await extractTweets(page, "https://x.com/@yetone", 1, "user-tweets");

    expect(page.navigatedUrls).toEqual(["https://x.com/yetone"]);
    expect(page.autoScrollCalls).toBe(1);
  });

  it("extracts /i/status tweet links without treating i as the author", () => {
    const article = {
      querySelector(selector: string) {
        if (selector === 'a[href*="/status/"]') {
          return { getAttribute: () => "/i/status/123" };
        }
        if (selector === '[data-testid="User-Name"]') {
          return { textContent: "Alice @alice" };
        }
        return { textContent: "" };
      },
      querySelectorAll(selector: string) {
        if (selector === '[data-testid="tweetText"]') {
          return [{ textContent: "hello" }];
        }
        return [];
      },
    };
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { querySelectorAll: () => [article] },
    });

    try {
      const rows = Function(`return ${buildTwitterTweetExtractionScript(1)}`)();

      expect(rows).toEqual([
        expect.objectContaining({
          id: "123",
          author: "alice",
          url: "https://x.com/i/status/123",
        }),
      ]);
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    }
  });
});
