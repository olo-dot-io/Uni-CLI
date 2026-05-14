/**
 * @owner   src/adapters/zhihu/answer-detail.ts
 * @does    Register full-content Zhihu answer detail reader.
 * @needs   Logged-in Zhihu browser session, answer API payload, exact answer target parsing.
 * @feeds   surface coverage ledger, long-form answer extraction workflows, reference parity checks.
 * @breaks  Zhihu answer URL shape or API content field drift can block answer detail extraction.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const ANSWER_ID_RE = /^\d+$/;
const ANSWER_TYPED_RE = /^answer:(\d+):(\d+)$/;
const ANSWER_PATH_RE = /^\/question\/(\d+)\/answer\/(\d+)\/?$/;
const BARE_ANSWER_PATH_RE = /^\/answer\/(\d+)\/?$/;
const QUESTION_PATH_RE = /^\/question\/(\d+)\/?$/;
const QUESTION_API_PATH_RE = /^\/api\/v4\/questions\/(\d+)\/?$/;

interface ZhihuAnswerTarget {
  answerId: string;
  questionId: string;
}

interface ZhihuAnswerPayload {
  id?: unknown;
  content?: unknown;
  voteup_count?: unknown;
  comment_count?: unknown;
  created_time?: unknown;
  updated_time?: unknown;
  author?: { name?: unknown };
  question?: { id?: unknown; title?: unknown; url?: unknown };
  error?: { message?: unknown };
  error_msg?: unknown;
  message?: unknown;
}

interface BrowserFetchResult {
  ok: boolean;
  status: number;
  text: string;
}

function stringField(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function countField(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function isoFromUnixSeconds(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
}

function pageOf(page: unknown): IPage {
  if (!page) throw new Error("Zhihu answer-detail requires a browser page.");
  return page as IPage;
}

export function stripZhihuAnswerHtml(value: unknown): string {
  return stringField(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseZhihuAnswerTarget(input: unknown): ZhihuAnswerTarget {
  const value = stringField(input).trim();
  if (!value) {
    throw new Error(
      "Zhihu answer target must be a numeric id, answer URL, or answer:<questionId>:<answerId>.",
    );
  }
  if (ANSWER_ID_RE.test(value)) return { answerId: value, questionId: "" };
  const typed = value.match(ANSWER_TYPED_RE);
  if (typed) return { questionId: typed[1], answerId: typed[2] };
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      (url.hostname !== "www.zhihu.com" && url.hostname !== "zhihu.com")
    ) {
      throw new Error("invalid host");
    }
    let match = url.pathname.match(ANSWER_PATH_RE);
    if (match) return { questionId: match[1], answerId: match[2] };
    match = url.pathname.match(BARE_ANSWER_PATH_RE);
    if (match) return { questionId: "", answerId: match[1] };
  } catch {
    throw new Error(
      "Zhihu answer target must be a numeric id, answer URL, or answer:<questionId>:<answerId>.",
    );
  }
  throw new Error(
    "Zhihu answer target must be a numeric id, answer URL, or answer:<questionId>:<answerId>.",
  );
}

export function extractQuestionIdFromZhihuUrl(input: unknown): string {
  const value = stringField(input).trim();
  if (!value) return "";
  if (!URL.canParse(value)) return "";
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "www.zhihu.com" && url.hostname !== "zhihu.com")
  ) {
    return "";
  }
  return (
    url.pathname.match(ANSWER_PATH_RE)?.[1] ??
    url.pathname.match(QUESTION_PATH_RE)?.[1] ??
    url.pathname.match(QUESTION_API_PATH_RE)?.[1] ??
    ""
  );
}

export function parseMaxContent(value: unknown): number {
  const n = value === undefined || value === null ? 0 : Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("--max-content must be a non-negative integer.");
  }
  return n;
}

async function browserFetchJson(page: IPage, url: string): Promise<unknown> {
  const raw = await page.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(url)}, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    const text = await response.text();
    return JSON.stringify({ ok: response.ok, status: response.status, text });
  })()`);
  const result = JSON.parse(stringField(raw)) as BrowserFetchResult;
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      throw new Error(
        `Zhihu answer-detail requires Zhihu cookies (HTTP ${result.status}).`,
      );
    }
    if (result.status === 404) {
      throw new Error("No Zhihu answer was found for the requested id.");
    }
    throw new Error(
      `Zhihu answer-detail request failed (HTTP ${result.status}).`,
    );
  }
  try {
    return JSON.parse(result.text);
  } catch (err) {
    throw new Error(
      `Zhihu answer-detail returned malformed JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function mapZhihuAnswerDetail(
  payload: ZhihuAnswerPayload,
  target: ZhihuAnswerTarget,
  currentQuestionId: string,
  maxContent: number,
): Record<string, unknown> {
  if (payload.error || payload.error_msg || payload.message) {
    throw new Error(
      `Zhihu answer-detail returned an error payload: ${stringField(
        payload.error?.message ?? payload.error_msg ?? payload.message,
      )}`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "content")) {
    throw new Error("Zhihu answer-detail payload did not include content.");
  }
  const question = payload.question ?? {};
  const questionId =
    target.questionId ||
    currentQuestionId ||
    extractQuestionIdFromZhihuUrl(question.url) ||
    stringField(question.id);
  const stripped = stripZhihuAnswerHtml(payload.content);
  const content =
    maxContent > 0 && stripped.length > maxContent
      ? stripped.slice(0, maxContent)
      : stripped;
  return {
    id: target.answerId || stringField(payload.id),
    author: stringField(payload.author?.name) || "anonymous",
    votes: countField(payload.voteup_count),
    comments: countField(payload.comment_count),
    question_id: questionId,
    question_title: stringField(question.title),
    url: questionId
      ? `https://www.zhihu.com/question/${questionId}/answer/${target.answerId}`
      : `https://www.zhihu.com/answer/${target.answerId}`,
    created_at: isoFromUnixSeconds(payload.created_time),
    updated_at: isoFromUnixSeconds(payload.updated_time),
    content,
  };
}

cli({
  site: "zhihu",
  name: "answer-detail",
  description: "知乎单个回答完整内容（按 answer ID 获取）",
  domain: "www.zhihu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "Answer ID, full Zhihu answer URL, or typed target",
    },
    {
      name: "max-content",
      type: "int",
      default: 0,
      description:
        "Optional cap on stripped content length; 0 returns full content",
    },
  ],
  columns: [
    "id",
    "author",
    "votes",
    "comments",
    "question_id",
    "question_title",
    "url",
    "created_at",
    "updated_at",
    "content",
  ],
  func: async (page, kwargs) => {
    const browser = pageOf(page);
    const target = parseZhihuAnswerTarget(kwargs.id);
    const maxContent = parseMaxContent(kwargs["max-content"]);
    await browser.goto(`https://www.zhihu.com/answer/${target.answerId}`);
    const currentQuestionId = extractQuestionIdFromZhihuUrl(
      await browser.url(),
    );
    const apiUrl = new URL(
      `https://www.zhihu.com/api/v4/answers/${target.answerId}`,
    );
    apiUrl.searchParams.set(
      "include",
      "content,voteup_count,comment_count,author,created_time,updated_time,question",
    );
    const payload = (await browserFetchJson(
      browser,
      apiUrl.toString(),
    )) as ZhihuAnswerPayload;
    return [
      mapZhihuAnswerDetail(payload, target, currentQuestionId, maxContent),
    ];
  },
});
