/**
 * Xiaohongshu Creator Note Detail — per-note analytics from the creator detail page.
 *
 * Navigates to the note detail page and parses rendered metrics plus
 * API-sourced trend and audience data.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

export interface CreatorNoteDetailRow {
  section: string;
  metric: string;
  value: string;
  extra: string;
}

interface NoteDetailApiPayload {
  noteBase?: {
    hour?: Record<string, unknown[]>;
    day?: Record<string, unknown[]>;
  };
  audienceTrend?: {
    no_data?: boolean;
    no_data_tip_msg?: string;
  };
  audienceSource?: {
    source?: Array<{
      title?: string;
      value_with_double?: number;
      info?: {
        imp_count?: number;
        view_count?: number;
        interaction_count?: number;
      };
    }>;
  };
  audienceSourceDetail?: {
    gender?: Array<{ title?: string; value?: number }>;
    age?: Array<{ title?: string; value?: number }>;
    city?: Array<{ title?: string; value?: number }>;
    interest?: Array<{ title?: string; value?: number }>;
  };
}

const DETAIL_API_ENDPOINTS: Array<{
  suffix: string;
  key: keyof NoteDetailApiPayload;
}> = [
  { suffix: "/api/galaxy/creator/datacenter/note/base", key: "noteBase" },
  {
    suffix: "/api/galaxy/creator/datacenter/note/analyze/audience/trend",
    key: "audienceTrend",
  },
  {
    suffix: "/api/galaxy/creator/datacenter/note/audience/source/detail",
    key: "audienceSourceDetail",
  },
  {
    suffix: "/api/galaxy/creator/datacenter/note/audience",
    key: "audienceSource",
  },
];

const NOTE_DETAIL_METRICS = [
  { label: "\u66dd\u5149\u6570", section: "\u57fa\u7840\u6570\u636e" },
  { label: "\u89c2\u770b\u6570", section: "\u57fa\u7840\u6570\u636e" },
  {
    label: "\u5c01\u9762\u70b9\u51fb\u7387",
    section: "\u57fa\u7840\u6570\u636e",
  },
  {
    label: "\u5e73\u5747\u89c2\u770b\u65f6\u957f",
    section: "\u57fa\u7840\u6570\u636e",
  },
  { label: "\u6da8\u7c89\u6570", section: "\u57fa\u7840\u6570\u636e" },
  { label: "\u70b9\u8d5e\u6570", section: "\u4e92\u52a8\u6570\u636e" },
  { label: "\u8bc4\u8bba\u6570", section: "\u4e92\u52a8\u6570\u636e" },
  { label: "\u6536\u85cf\u6570", section: "\u4e92\u52a8\u6570\u636e" },
  { label: "\u5206\u4eab\u6570", section: "\u4e92\u52a8\u6570\u636e" },
] as const;

const NOTE_DETAIL_METRIC_LABELS = new Set<string>(
  NOTE_DETAIL_METRICS.map((m) => m.label),
);
const NOTE_DETAIL_SECTIONS = new Set<string>(
  NOTE_DETAIL_METRICS.map((m) => m.section),
);
const NOTE_DETAIL_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function findPublishedAt(text: string): string {
  const match = text.match(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/);
  return match?.[0] ?? "";
}

function toPercentString(value?: number): string {
  return value == null ? "" : `${value}%`;
}

interface DomMetric {
  label: string;
  value: string;
  extra: string;
}

interface DomSection {
  title: string;
  metrics: DomMetric[];
}

interface DomData {
  title: string;
  infoText: string;
  sections: DomSection[];
}

function parseCreatorNoteDetailDomData(
  dom: DomData | null | undefined,
  noteId: string,
): CreatorNoteDetailRow[] {
  if (!dom) return [];
  const title = typeof dom.title === "string" ? dom.title.trim() : "";
  const infoText = typeof dom.infoText === "string" ? dom.infoText : "";
  const sections = Array.isArray(dom.sections) ? dom.sections : [];

  const rows: CreatorNoteDetailRow[] = [
    { section: "note_info", metric: "note_id", value: noteId, extra: "" },
    { section: "note_info", metric: "title", value: title, extra: "" },
    {
      section: "note_info",
      metric: "published_at",
      value: findPublishedAt(infoText),
      extra: "",
    },
  ];

  for (const section of sections) {
    if (!NOTE_DETAIL_SECTIONS.has(section.title)) continue;
    for (const metric of section.metrics) {
      if (!NOTE_DETAIL_METRIC_LABELS.has(metric.label)) continue;
      rows.push({
        section: section.title,
        metric: metric.label,
        value: metric.value,
        extra: metric.extra,
      });
    }
  }

  const hasMetric = rows.some(
    (row) => row.section !== "note_info" && row.value,
  );
  return hasMetric ? rows : [];
}

function parseCreatorNoteDetailText(
  bodyText: string,
  noteId: string,
): CreatorNoteDetailRow[] {
  const lines = bodyText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const publishedAt =
    lines.find((line) => NOTE_DETAIL_DATETIME_RE.test(line)) ?? "";
  const rows: CreatorNoteDetailRow[] = [
    { section: "note_info", metric: "note_id", value: noteId, extra: "" },
    { section: "note_info", metric: "title", value: "", extra: "" },
    {
      section: "note_info",
      metric: "published_at",
      value: publishedAt,
      extra: "",
    },
  ];

  for (const metric of NOTE_DETAIL_METRICS) {
    const index = lines.indexOf(metric.label);
    if (index < 0) continue;
    let value = "";
    for (let i = index + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (NOTE_DETAIL_METRIC_LABELS.has(line)) break;
      if (!value) {
        value = line;
        break;
      }
    }
    rows.push({
      section: metric.section,
      metric: metric.label,
      value,
      extra: "",
    });
  }

  return rows;
}

function appendAudienceRows(
  rows: CreatorNoteDetailRow[],
  payload?: NoteDetailApiPayload,
): void {
  const sourceItems = payload?.audienceSource?.source ?? [];
  for (const item of sourceItems) {
    if (!item.title) continue;
    const extras: string[] = [];
    if (item.info?.imp_count != null) extras.push(`imp ${item.info.imp_count}`);
    if (item.info?.view_count != null)
      extras.push(`views ${item.info.view_count}`);
    if (item.info?.interaction_count != null)
      extras.push(`interact ${item.info.interaction_count}`);
    rows.push({
      section: "audience_source",
      metric: item.title,
      value: toPercentString(item.value_with_double),
      extra: extras.join(" | "),
    });
  }

  const groups: Array<{ label: string; key: keyof typeof detail }> = [
    { label: "gender", key: "gender" },
    { label: "age", key: "age" },
    { label: "city", key: "city" },
    { label: "interest", key: "interest" },
  ];
  const detail = payload?.audienceSourceDetail ?? {};
  for (const { label, key } of groups) {
    const items =
      (detail[key] as Array<{ title?: string; value?: number }>) ?? [];
    for (const item of items) {
      if (!item.title) continue;
      rows.push({
        section: "audience_portrait",
        metric: `${label}/${item.title}`,
        value: toPercentString(item.value),
        extra: "",
      });
    }
  }
}

async function captureNoteDetailPayload(
  page: IPage,
  noteId: string,
): Promise<NoteDetailApiPayload | null> {
  const payload: NoteDetailApiPayload = {};
  let captured = 0;

  for (const { suffix, key } of DETAIL_API_ENDPOINTS) {
    const apiUrl = `${suffix}?note_id=${noteId}`;
    try {
      const data = (await page.evaluate(`
        async () => {
          try {
            const resp = await fetch(${JSON.stringify(apiUrl)}, { credentials: 'include' });
            if (!resp.ok) return null;
            const json = await resp.json();
            return JSON.stringify(json.data ?? {});
          } catch { return null; }
        }
      `)) as string | null;
      if (data && typeof data === "string") {
        try {
          (payload as Record<string, unknown>)[key] = JSON.parse(data);
          captured++;
        } catch {
          /* empty */
        }
      }
    } catch {
      /* empty */
    }
  }

  return captured > 0 ? payload : null;
}

export async function fetchCreatorNoteDetailRows(
  page: IPage,
  noteId: string,
): Promise<CreatorNoteDetailRow[]> {
  await page.goto(
    `https://creator.xiaohongshu.com/statistics/note-detail?noteId=${encodeURIComponent(noteId)}`,
  );

  let domData: DomData | null = null;
  try {
    domData = (await page.evaluate(`() => {
      const norm = (value) => (value || '').trim();
      const sections = Array.from(document.querySelectorAll('.shell-container')).map((container) => {
        const containerText = norm(container.innerText);
        const title = containerText.startsWith('互动数据') ? '互动数据'
          : containerText.includes('基础数据') ? '基础数据' : '';
        const metrics = Array.from(container.querySelectorAll('.block-container.block')).map((block) => ({
          label: norm(block.querySelector('.des')?.innerText),
          value: norm(block.querySelector('.content')?.innerText),
          extra: norm(block.querySelector('.text-with-fans')?.innerText),
        })).filter((metric) => metric.label && metric.value);
        return { title, metrics };
      }).filter((section) => section.title && section.metrics.length > 0);
      return {
        title: norm(document.querySelector('.note-title')?.innerText),
        infoText: norm(document.querySelector('.note-info-content')?.innerText),
        sections,
      };
    }`)) as DomData;
  } catch {
    /* empty */
  }

  let rows = parseCreatorNoteDetailDomData(domData, noteId);
  if (rows.length === 0) {
    const bodyText = (await page.evaluate(
      "() => document.body.innerText",
    )) as string;
    rows = parseCreatorNoteDetailText(
      typeof bodyText === "string" ? bodyText : "",
      noteId,
    );
  }

  const apiPayload = await captureNoteDetailPayload(page, noteId).catch(
    () => null,
  );
  if (apiPayload) {
    appendAudienceRows(rows, apiPayload);
  }

  return rows;
}

cli({
  site: "xiaohongshu",
  name: "creator-note-detail",
  description:
    "Xiaohongshu single note detail page data (core metrics + audience + trends)",
  domain: "creator.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "note-id",
      positional: true,
      required: true,
      description: "Note ID (from creator-notes or note-detail page URL)",
    },
  ],
  columns: ["section", "metric", "value", "extra"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const noteId: string = String(kwargs["note-id"]);
    const rows = await fetchCreatorNoteDetailRows(p, noteId);

    const hasCoreMetric = rows.some(
      (row) => row.section !== "note_info" && row.value,
    );
    if (!hasCoreMetric) {
      throw new Error(
        "No note detail data found. Check note_id and login status for creator.xiaohongshu.com.",
      );
    }

    return rows;
  },
});
