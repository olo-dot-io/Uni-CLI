/**
 * Xiaohongshu Creator Note List — per-note metrics from the creator backend.
 *
 * Captures the real creator analytics API response so the list
 * includes stable note ids and detail-page URLs.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import {
  fetchCreatorNotes,
  type CreatorNoteRow,
} from "./_creator-notes-data.js";

export { fetchCreatorNotes, type CreatorNoteRow };

cli({
  site: "xiaohongshu",
  name: "creator-notes",
  description:
    "Xiaohongshu creator note list with per-note metrics (title/date/views/likes/collects/comments)",
  domain: "creator.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of notes to return",
    },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "date",
    "views",
    "likes",
    "collects",
    "comments",
    "url",
  ],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = Number(kwargs.limit) || 20;
    const notes = await fetchCreatorNotes(p, limit);

    if (!Array.isArray(notes) || notes.length === 0) {
      throw new Error(
        "No notes found. Are you logged into creator.xiaohongshu.com?",
      );
    }

    return notes.slice(0, limit).map((n, i) => ({
      rank: i + 1,
      id: n.id,
      title: n.title,
      date: n.date,
      views: n.views,
      likes: n.likes,
      collects: n.collects,
      comments: n.comments,
      url: n.url,
    }));
  },
});
