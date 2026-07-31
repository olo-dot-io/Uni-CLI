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
