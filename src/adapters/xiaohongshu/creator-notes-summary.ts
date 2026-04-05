/**
 * Xiaohongshu Creator Notes Summary — batch summary for recent notes.
 *
 * Combines creator-notes and creator-note-detail into a single command
 * that returns one summary row per note.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { fetchCreatorNotes, type CreatorNoteRow } from "./creator-notes.js";
import {
  fetchCreatorNoteDetailRows,
  type CreatorNoteDetailRow,
} from "./creator-note-detail.js";

interface CreatorNoteSummaryRow {
  rank: number;
  id: string;
  title: string;
  views: string;
  likes: string;
  collects: string;
  comments: string;
  shares: string;
  avg_view_time: string;
  rise_fans: string;
  url: string;
}

function findDetailValue(rows: CreatorNoteDetailRow[], metric: string): string {
  return rows.find((row) => row.metric === metric)?.value ?? "";
}

function summarizeCreatorNote(
  note: CreatorNoteRow,
  rows: CreatorNoteDetailRow[],
  rank: number,
): CreatorNoteSummaryRow {
  return {
    rank,
    id: note.id,
    title: note.title,
    views: findDetailValue(rows, "\u89c2\u770b\u6570") || String(note.views),
    likes: findDetailValue(rows, "\u70b9\u8d5e\u6570") || String(note.likes),
    collects:
      findDetailValue(rows, "\u6536\u85cf\u6570") || String(note.collects),
    comments:
      findDetailValue(rows, "\u8bc4\u8bba\u6570") || String(note.comments),
    shares: findDetailValue(rows, "\u5206\u4eab\u6570"),
    avg_view_time: findDetailValue(
      rows,
      "\u5e73\u5747\u89c2\u770b\u65f6\u957f",
    ),
    rise_fans: findDetailValue(rows, "\u6da8\u7c89\u6570"),
    url: note.url,
  };
}

cli({
  site: "xiaohongshu",
  name: "creator-notes-summary",
  description:
    "Xiaohongshu batch summary for recent notes (list + per-note key metrics)",
  domain: "creator.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "limit",
      type: "int",
      default: 3,
      description: "Number of recent notes to summarize",
    },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "views",
    "likes",
    "collects",
    "comments",
    "shares",
    "avg_view_time",
    "rise_fans",
    "url",
  ],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = Number(kwargs.limit) || 3;
    const notes = await fetchCreatorNotes(p, limit);

    if (!notes.length) {
      throw new Error(
        "No notes found. Are you logged into creator.xiaohongshu.com?",
      );
    }

    const results: CreatorNoteSummaryRow[] = [];
    for (const [index, note] of notes.entries()) {
      if (!note.id) {
        results.push({
          rank: index + 1,
          id: note.id,
          title: note.title,
          views: String(note.views),
          likes: String(note.likes),
          collects: String(note.collects),
          comments: String(note.comments),
          shares: "",
          avg_view_time: "",
          rise_fans: "",
          url: note.url,
        });
        continue;
      }

      const detailRows = await fetchCreatorNoteDetailRows(p, note.id);
      results.push(summarizeCreatorNote(note, detailRows, index + 1));
    }

    return results;
  },
});
