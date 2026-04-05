/**
 * Xiaohongshu user — public notes from a user profile page.
 *
 * Navigates to the profile, reads __INITIAL_STATE__ for note data,
 * and scrolls to load more if needed.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { extractXhsUserNotes, normalizeXhsUserId } from "./user-helpers.js";

async function readUserSnapshot(
  page: IPage,
): Promise<{ noteGroups: unknown; pageData: unknown }> {
  return (await page.evaluate(`
    (() => {
      const safeClone = (value) => {
        try {
          return JSON.parse(JSON.stringify(value ?? null));
        } catch {
          return null;
        }
      };
      const userStore = window.__INITIAL_STATE__?.user || {};
      return {
        noteGroups: safeClone(userStore.notes?._value || userStore.notes || []),
        pageData: safeClone(userStore.userPageData?._value || userStore.userPageData || {}),
      };
    })()
  `)) as { noteGroups: unknown; pageData: unknown };
}

cli({
  site: "xiaohongshu",
  name: "user",
  description: "Get public notes from a Xiaohongshu user profile",
  domain: "www.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "id",
      required: true,
      positional: true,
      description: "User id or profile URL",
    },
    { name: "limit", type: "int", default: 15, description: "Number of notes" },
  ],
  columns: ["id", "title", "type", "likes", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const userId = normalizeXhsUserId(String(kwargs.id));
    const limit = Math.max(1, Number(kwargs.limit ?? 15));

    await p.goto(`https://www.xiaohongshu.com/user/profile/${userId}`);

    let snapshot = await readUserSnapshot(p);
    let results = extractXhsUserNotes(snapshot ?? {}, userId);
    let previousCount = results.length;

    for (let i = 0; results.length < limit && i < 4; i += 1) {
      await p.autoScroll({ maxScrolls: 1, delay: 1500 });
      await p.wait(1);

      snapshot = await readUserSnapshot(p);
      const nextResults = extractXhsUserNotes(snapshot ?? {}, userId);
      if (nextResults.length <= previousCount) break;

      results = nextResults;
      previousCount = nextResults.length;
    }

    if (results.length === 0) {
      throw new Error("No public notes found for this Xiaohongshu user.");
    }

    return results.slice(0, limit);
  },
});
