/**
 * Xiaohongshu Creator Note List — per-note metrics from the creator backend.
 *
 * Captures the real creator analytics API response so the list
 * includes stable note ids and detail-page URLs.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const NOTE_ANALYZE_API_PATH =
  "/api/galaxy/creator/datacenter/note/analyze/list";
const NOTE_DETAIL_PAGE_URL =
  "https://creator.xiaohongshu.com/statistics/note-detail";

export interface CreatorNoteRow {
  id: string;
  title: string;
  date: string;
  views: number;
  likes: number;
  collects: number;
  comments: number;
  url: string;
}

interface CreatorAnalyzeApiResponse {
  error?: string;
  data?: {
    note_infos?: Array<{
      id?: string;
      title?: string;
      post_time?: number;
      read_count?: number;
      like_count?: number;
      fav_count?: number;
      comment_count?: number;
    }>;
    total?: number;
  };
}

function buildNoteDetailUrl(noteId?: string): string {
  return noteId
    ? `${NOTE_DETAIL_PAGE_URL}?noteId=${encodeURIComponent(noteId)}`
    : "";
}

function formatPostTime(ts?: number): string {
  if (!ts) return "";
  const date = new Date(ts + 8 * 3600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}年${pad(date.getUTCMonth() + 1)}月${pad(date.getUTCDate())}日 ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function mapAnalyzeItems(
  items: NonNullable<CreatorAnalyzeApiResponse["data"]>["note_infos"],
): CreatorNoteRow[] {
  return (items ?? []).map((item) => ({
    id: item.id ?? "",
    title: item.title ?? "",
    date: formatPostTime(item.post_time),
    views: item.read_count ?? 0,
    likes: item.like_count ?? 0,
    collects: item.fav_count ?? 0,
    comments: item.comment_count ?? 0,
    url: buildNoteDetailUrl(item.id),
  }));
}

export async function fetchCreatorNotes(
  page: IPage,
  limit: number,
): Promise<CreatorNoteRow[]> {
  const pageSize = Math.min(Math.max(limit, 10), 20);
  const maxPages = Math.max(1, Math.ceil(limit / pageSize));
  const notes: CreatorNoteRow[] = [];

  await page.goto(
    `https://creator.xiaohongshu.com/statistics/data-analysis?type=0&page_size=${pageSize}&page_num=1`,
  );

  for (
    let pageNum = 1;
    pageNum <= maxPages && notes.length < limit;
    pageNum++
  ) {
    const apiPath = `${NOTE_ANALYZE_API_PATH}?type=0&page_size=${pageSize}&page_num=${pageNum}`;
    const fetched = (await page.evaluate(`
      async () => {
        try {
          const resp = await fetch(${JSON.stringify(apiPath)}, { credentials: 'include' });
          if (!resp.ok) return { error: 'HTTP ' + resp.status };
          return await resp.json();
        } catch (e) {
          return { error: e?.message ?? String(e) };
        }
      }
    `)) as CreatorAnalyzeApiResponse | undefined;

    const items = fetched?.data?.note_infos ?? [];
    if (!items.length) break;

    notes.push(...mapAnalyzeItems(items));
    if (items.length < pageSize) break;
  }

  return notes.slice(0, limit);
}

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
