import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import { requireFacebookMarketplaceLimit } from "./marketplace-extra.js";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
  };
}

describe("facebook marketplace agent-facing commands", () => {
  it("validates limits without silent clamps", () => {
    expect(requireFacebookMarketplaceLimit(undefined)).toBe(20);
    expect(requireFacebookMarketplaceLimit(2)).toBe(2);
    expect(() => requireFacebookMarketplaceLimit(0)).toThrow(
      "positive integer",
    );
    expect(() => requireFacebookMarketplaceLimit(101)).toThrow("<= 100");
  });

  it("lists Marketplace seller listings", async () => {
    const command = resolveCommand("facebook", "marketplace-listings")?.command;
    const page = pageMock([
      {
        authRequired: false,
        rows: [
          {
            title: "Black electric standing desk",
            price: "CA$80",
            status: "Active",
            listed: "Listed on 4/26",
            clicks: "87",
            actions: ["Mark as sold", "Share"],
          },
          {
            title: "Large gray corduroy beanbag chair",
            price: "CA$30",
          },
        ],
      },
    ]);
    await expect(command!.func!(page, { limit: 1 })).resolves.toEqual([
      {
        index: 1,
        title: "Black electric standing desk",
        price: "CA$80",
        status: "Active",
        listed: "Listed on 4/26",
        clicks: "87",
        actions: "Mark as sold, Share",
      },
    ]);
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.facebook.com/marketplace/you/selling/",
    );
    expect(page.wait).toHaveBeenCalledWith(4);
  });

  it("lists Marketplace inbox conversations", async () => {
    const command = resolveCommand("facebook", "marketplace-inbox")?.command;
    const page = pageMock([
      {
        authRequired: false,
        rows: [
          {
            buyer: "Kulwant",
            listing: "White 3-tier rolling utility cart",
            snippet: "Can I pick up today?",
            time: "3:43 PM",
            unread: true,
          },
          {
            buyer: "Gabriel",
            listing: "Black electric standing desk",
            snippet: "Yes, still available.",
            time: "12:17 PM",
            unread: false,
          },
        ],
      },
    ]);
    await expect(command!.func!(page, { limit: 2 })).resolves.toEqual([
      {
        index: 1,
        buyer: "Kulwant",
        listing: "White 3-tier rolling utility cart",
        snippet: "Can I pick up today?",
        time: "3:43 PM",
        unread: true,
      },
      {
        index: 2,
        buyer: "Gabriel",
        listing: "Black electric standing desk",
        snippet: "Yes, still available.",
        time: "12:17 PM",
        unread: false,
      },
    ]);
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.facebook.com/marketplace/inbox/",
    );
    expect(page.wait).toHaveBeenCalledWith(4);
  });

  it("fails before navigation on invalid limits", async () => {
    const command = resolveCommand("facebook", "marketplace-listings")?.command;
    const page = pageMock([]);
    await expect(command!.func!(page, { limit: 0 })).rejects.toThrow(
      "positive integer",
    );
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("classifies auth and empty Marketplace pages", async () => {
    const listings = resolveCommand(
      "facebook",
      "marketplace-listings",
    )?.command;
    const inbox = resolveCommand("facebook", "marketplace-inbox")?.command;
    await expect(
      listings!.func!(pageMock([{ authRequired: true, rows: [] }]), {
        limit: 5,
      }),
    ).rejects.toThrow("requires an active signed-in Facebook session");
    await expect(
      inbox!.func!(pageMock([{ authRequired: false, rows: [] }]), { limit: 5 }),
    ).rejects.toThrow("No Facebook Marketplace inbox conversations");
  });
});
