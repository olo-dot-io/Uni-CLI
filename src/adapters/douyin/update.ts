/**
 * Douyin update — update video metadata (reschedule or change caption).
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { browserFetch } from "./_shared/browser-fetch.js";
import { toUnixSeconds, validateTiming } from "./_shared/timing.js";

cli({
  site: "douyin",
  name: "update",
  description: "Update Douyin video metadata (reschedule or change caption)",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "aweme_id",
      required: true,
      positional: true,
      description: "Video aweme_id",
    },
    {
      name: "reschedule",
      default: "",
      description: "New publish time (ISO8601 or Unix seconds)",
    },
    { name: "caption", default: "", description: "New caption text" },
  ],
  columns: ["status"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    if (!kwargs.reschedule && !kwargs.caption) {
      throw new Error("Must provide --reschedule or --caption");
    }
    if (kwargs.reschedule) {
      const newTime = toUnixSeconds(kwargs.reschedule as string | number);
      validateTiming(newTime);
      await browserFetch(
        p,
        "POST",
        "https://creator.douyin.com/web/api/media/update/timer/?aid=1128",
        { body: { aweme_id: kwargs.aweme_id, publish_time: newTime } },
      );
    }
    if (kwargs.caption) {
      await browserFetch(
        p,
        "POST",
        "https://creator.douyin.com/web/api/media/update/desc/?aid=1128",
        { body: { aweme_id: kwargs.aweme_id, desc: kwargs.caption } },
      );
    }
    return [{ status: "Updated successfully" }];
  },
});
