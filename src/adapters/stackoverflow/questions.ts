/**
 * @owner   src/adapters/stackoverflow/questions.ts
 * @does    Register agent-facing Stack Overflow read, related, tag, and user commands.
 * @needs   Public Stack Exchange API, strict numeric ids, bounded pagination, HTML-to-text conversion.
 * @feeds   surface coverage ledger, Stack Overflow research workflows, question/answer readers.
 * @breaks  Stack Exchange envelope drift, partial comment pagination, or weak entity decoding corrupts reads.
 */

import { cli, Strategy } from "../../registry.js";

const STACK_API = "https://api.stackexchange.com/2.3";
const STACK_SITE = "stackoverflow";
const STACK_MAX_PAGE_SIZE = 100;
const RELATED_SORTS = ["rank", "activity", "votes", "creation"] as const;
const TAG_SORTS = [
  "activity",
  "votes",
  "creation",
  "hot",
  "week",
  "month",
] as const;

interface StackOwner {
  display_name?: unknown;
  user_id?: unknown;
}

interface StackQuestion {
  question_id?: unknown;
  accepted_answer_id?: unknown;
  title?: unknown;
  body?: unknown;
  score?: unknown;
  answer_count?: unknown;
  view_count?: unknown;
  is_answered?: unknown;
  tags?: unknown;
  owner?: StackOwner;
  creation_date?: unknown;
  last_activity_date?: unknown;
  link?: unknown;
}

interface StackAnswer {
  answer_id?: unknown;
  is_accepted?: unknown;
  body?: unknown;
  score?: unknown;
  owner?: StackOwner;
}

interface StackComment {
  post_id?: unknown;
  body?: unknown;
  score?: unknown;
  owner?: StackOwner;
}

interface StackUser {
  user_id?: unknown;
  display_name?: unknown;
  reputation?: unknown;
  badge_counts?: {
    gold?: unknown;
    silver?: unknown;
    bronze?: unknown;
  };
  location?: unknown;
  creation_date?: unknown;
  last_access_date?: unknown;
  link?: unknown;
}

interface StackEnvelope<T> {
  items?: T[];
  has_more?: unknown;
  error_id?: unknown;
  error_name?: unknown;
  error_message?: unknown;
}

type FetchStackJson = <T>(
  path: string,
  params: Record<string, unknown>,
  label: string,
) => Promise<StackEnvelope<T>>;

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boolField(value: unknown): boolean {
  return value === true;
}

export function requireStackQuestionId(value: unknown, label = "id"): string {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw new Error(`stackoverflow ${label} must be a numeric question id.`);
  }
  return id;
}

export function requireStackString(value: unknown, label: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`stackoverflow ${label} cannot be empty.`);
  return raw;
}

export function requireStackLimit(
  value: unknown,
  fallback: number,
  max: number,
  label: string,
): number {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new Error(
      `stackoverflow ${label} must be an integer in [1, ${max}].`,
    );
  }
  return limit;
}

export function requireStackMinInt(
  value: unknown,
  fallback: number,
  min: number,
  label: string,
): number {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`stackoverflow ${label} must be an integer >= ${min}.`);
  }
  return n;
}

function requireSort<T extends readonly string[]>(
  value: unknown,
  fallback: T[number],
  allowed: T,
  label: string,
): T[number] {
  const sort = String(value ?? fallback).toLowerCase();
  if (!allowed.includes(sort)) {
    throw new Error(
      `stackoverflow ${label} must be one of ${allowed.join(", ")}.`,
    );
  }
  return sort;
}

export function stackEpochToDate(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) && n > 0
    ? new Date(n * 1000).toISOString().slice(0, 10)
    : "";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
  hellip: "...",
  mdash: "-",
  ndash: "-",
  laquo: "<<",
  raquo: ">>",
  copy: "(c)",
  reg: "(R)",
  trade: "(TM)",
  euro: "EUR",
  pound: "GBP",
  yen: "JPY",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

export function decodeStackHtmlEntities(value: unknown): string {
  return String(value ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-zA-Z]+|#39);/g, (match, name: string) => {
      return NAMED_ENTITIES[name] ?? match;
    });
}

export function stackHtmlToText(value: unknown): string {
  return decodeStackHtmlEntities(
    String(value ?? "")
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n$1\n")
      .replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
      .replace(/<p[^>]*>/gi, "\n\n")
      .replace(/<\/p>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/li>/gi, "")
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stackAuthor(owner: StackOwner | undefined): string {
  return decodeStackHtmlEntities(owner?.display_name) || "[deleted]";
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength)} ... [truncated]`
    : text;
}

function indentLines(text: string, depth: number): string {
  if (depth <= 0) return text;
  const prefix = `${"  ".repeat(depth)}> `;
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function stackItems<T>(envelope: StackEnvelope<T>, label: string): T[] {
  const items = Array.isArray(envelope.items) ? envelope.items : [];
  if (items.length === 0) {
    throw new Error(`${label} returned no items.`);
  }
  return items;
}

async function fetchStackJson<T>(
  path: string,
  params: Record<string, unknown>,
  label: string,
): Promise<StackEnvelope<T>> {
  const url = new URL(`${STACK_API}${path}`);
  url.searchParams.set("site", STACK_SITE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "unicli-stackoverflow/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Stack Exchange API returned HTTP ${response.status} for ${label}.`,
    );
  }
  const envelope = (await response.json()) as StackEnvelope<T>;
  if (envelope.error_id) {
    throw new Error(
      `Stack Exchange API error ${String(envelope.error_id)} for ${label}: ${String(
        envelope.error_message ?? envelope.error_name ?? "",
      )}`,
    );
  }
  return envelope;
}

export function mapStackQuestionRows(
  questions: StackQuestion[],
): Array<Record<string, unknown>> {
  return questions.map((question, index) => {
    const id = numberField(question.question_id);
    return {
      rank: index + 1,
      id,
      title: decodeStackHtmlEntities(question.title),
      score: numberField(question.score),
      answers: numberField(question.answer_count),
      views: numberField(question.view_count),
      isAnswered: boolField(question.is_answered),
      tags: Array.isArray(question.tags)
        ? question.tags.map(String).join(", ")
        : "",
      author: decodeStackHtmlEntities(question.owner?.display_name),
      createdAt: stackEpochToDate(question.creation_date),
      lastActivityAt: stackEpochToDate(question.last_activity_date),
      url:
        stringField(question.link) ||
        (id ? `https://stackoverflow.com/questions/${id}` : ""),
    };
  });
}

export function mapStackUserRows(
  users: StackUser[],
): Array<Record<string, unknown>> {
  return users.map((user) => {
    const id = numberField(user.user_id);
    return {
      userId: id,
      displayName: decodeStackHtmlEntities(user.display_name),
      reputation: numberField(user.reputation),
      goldBadges: numberField(user.badge_counts?.gold),
      silverBadges: numberField(user.badge_counts?.silver),
      bronzeBadges: numberField(user.badge_counts?.bronze),
      location: decodeStackHtmlEntities(user.location),
      createdAt: stackEpochToDate(user.creation_date),
      lastAccessAt: stackEpochToDate(user.last_access_date),
      url:
        stringField(user.link) ||
        (id ? `https://stackoverflow.com/users/${id}` : ""),
    };
  });
}

function acceptedAnswerId(question: StackQuestion): number {
  return numberField(question.accepted_answer_id);
}

function answerId(answer: StackAnswer): number {
  return numberField(answer.answer_id);
}

export function sortStackAnswers(
  question: StackQuestion,
  answers: StackAnswer[],
): StackAnswer[] {
  const accepted = acceptedAnswerId(question);
  return answers.slice().sort((a, b) => {
    const aAccepted = boolField(a.is_accepted) || answerId(a) === accepted;
    const bAccepted = boolField(b.is_accepted) || answerId(b) === accepted;
    if (aAccepted !== bAccepted) return aAccepted ? -1 : 1;
    return numberField(b.score) - numberField(a.score);
  });
}

async function fetchAcceptedAnswerIfMissing(
  question: StackQuestion,
  answers: StackAnswer[],
  fetchJson: FetchStackJson,
  label: string,
): Promise<StackAnswer[]> {
  const accepted = acceptedAnswerId(question);
  if (!accepted || answers.some((answer) => answerId(answer) === accepted)) {
    return answers;
  }
  const envelope = await fetchJson<StackAnswer>(
    `/answers/${accepted}`,
    { filter: "withbody" },
    `${label}/accepted-answer`,
  );
  const [answer] = envelope.items ?? [];
  return answer ? answers.concat(answer) : answers;
}

async function fetchAnswerCommentsByAnswerId(
  answers: StackAnswer[],
  commentsLimit: number,
  fetchJson: FetchStackJson,
  label: string,
): Promise<Map<number, StackComment[]>> {
  const commentsByAnswer = new Map<number, StackComment[]>();
  if (answers.length === 0) return commentsByAnswer;
  const ids = answers.map(answerId).filter(Boolean).join(";");
  if (!ids) return commentsByAnswer;
  const pageSize = Math.min(
    STACK_MAX_PAGE_SIZE,
    answers.length * commentsLimit,
  );
  const envelope = await fetchJson<StackComment>(
    `/answers/${ids}/comments`,
    {
      filter: "withbody",
      order: "asc",
      sort: "creation",
      pagesize: pageSize,
    },
    `${label}/answer-comments`,
  );
  for (const comment of envelope.items ?? []) {
    const postId = numberField(comment.post_id);
    if (!postId) continue;
    const comments = commentsByAnswer.get(postId) ?? [];
    comments.push(comment);
    commentsByAnswer.set(postId, comments);
  }
  if (envelope.has_more) {
    const selectedAnswerIsPartial = answers.some((answer) => {
      return (
        (commentsByAnswer.get(answerId(answer)) ?? []).length < commentsLimit
      );
    });
    if (selectedAnswerIsPartial) {
      throw new Error(
        `Stack Exchange answer comments for ${label} exceed one API page.`,
      );
    }
  }
  return commentsByAnswer;
}

export async function buildStackReadRows(
  question: StackQuestion | undefined,
  questionComments: StackComment[],
  answers: StackAnswer[],
  fetchJson: FetchStackJson,
  options: {
    answersLimit: number;
    commentsLimit: number;
    maxLength: number;
    label: string;
  },
): Promise<Array<Record<string, unknown>>> {
  if (!question) throw new Error(`${options.label} question not found.`);
  const withAccepted = await fetchAcceptedAnswerIfMissing(
    question,
    answers,
    fetchJson,
    options.label,
  );
  const orderedAnswers = sortStackAnswers(question, withAccepted).slice(
    0,
    options.answersLimit,
  );
  const answerComments = await fetchAnswerCommentsByAnswerId(
    orderedAnswers,
    options.commentsLimit,
    fetchJson,
    options.label,
  );
  const rows: Array<Record<string, unknown>> = [];
  const questionBody = stackHtmlToText(question.body);
  const questionText = [
    decodeStackHtmlEntities(question.title),
    questionBody,
    stringField(question.link),
  ]
    .filter(Boolean)
    .join("\n\n");
  rows.push({
    type: "POST",
    author: stackAuthor(question.owner),
    score: numberField(question.score),
    accepted: "",
    text: truncate(questionText, options.maxLength),
  });
  for (const comment of questionComments.slice(0, options.commentsLimit)) {
    rows.push({
      type: "Q-COMMENT",
      author: stackAuthor(comment.owner),
      score: numberField(comment.score),
      accepted: "",
      text: truncate(
        indentLines(stackHtmlToText(comment.body), 1),
        options.maxLength,
      ),
    });
  }
  for (const answer of orderedAnswers) {
    rows.push({
      type: "ANSWER",
      author: stackAuthor(answer.owner),
      score: numberField(answer.score),
      accepted: boolField(answer.is_accepted) ? "true" : "",
      text: truncate(stackHtmlToText(answer.body), options.maxLength),
    });
    for (const comment of (answerComments.get(answerId(answer)) ?? []).slice(
      0,
      options.commentsLimit,
    )) {
      rows.push({
        type: "A-COMMENT",
        author: stackAuthor(comment.owner),
        score: numberField(comment.score),
        accepted: "",
        text: truncate(
          indentLines(stackHtmlToText(comment.body), 1),
          options.maxLength,
        ),
      });
    }
  }
  return rows;
}

cli({
  site: "stackoverflow",
  name: "read",
  description: "Read a Stack Overflow question with answers and comments",
  domain: "stackoverflow.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "Stack Overflow question id",
    },
    {
      name: "answers-limit",
      type: "int",
      default: 10,
      description: "Max answers to include",
    },
    {
      name: "comments-limit",
      type: "int",
      default: 5,
      description: "Max comments per question or answer",
    },
    {
      name: "max-length",
      type: "int",
      default: 4000,
      description: "Max characters per body",
    },
  ],
  columns: ["type", "author", "score", "accepted", "text"],
  func: async (_page, kwargs) => {
    const id = requireStackQuestionId(kwargs.id);
    const answersLimit = requireStackLimit(
      kwargs["answers-limit"] ?? kwargs.answersLimit,
      10,
      STACK_MAX_PAGE_SIZE,
      "read answers-limit",
    );
    const commentsLimit = requireStackLimit(
      kwargs["comments-limit"] ?? kwargs.commentsLimit,
      5,
      STACK_MAX_PAGE_SIZE,
      "read comments-limit",
    );
    const maxLength = requireStackMinInt(
      kwargs["max-length"] ?? kwargs.maxLength,
      4000,
      100,
      "read max-length",
    );
    const label = `stackoverflow/${id}`;
    const [questionEnvelope, commentsEnvelope, answersEnvelope] =
      await Promise.all([
        fetchStackJson<StackQuestion>(
          `/questions/${id}`,
          { filter: "withbody" },
          label,
        ),
        fetchStackJson<StackComment>(
          `/questions/${id}/comments`,
          {
            filter: "withbody",
            order: "asc",
            sort: "creation",
            pagesize: commentsLimit,
          },
          `${label}/comments`,
        ),
        fetchStackJson<StackAnswer>(
          `/questions/${id}/answers`,
          {
            filter: "withbody",
            order: "desc",
            sort: "votes",
            pagesize: answersLimit,
          },
          `${label}/answers`,
        ),
      ]);
    return buildStackReadRows(
      (questionEnvelope.items ?? [])[0],
      commentsEnvelope.items ?? [],
      answersEnvelope.items ?? [],
      fetchStackJson,
      { answersLimit, commentsLimit, maxLength, label },
    );
  },
});

cli({
  site: "stackoverflow",
  name: "related",
  description: "List Stack Overflow questions related to a question id",
  domain: "stackoverflow.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "Stack Overflow question id",
    },
    {
      name: "sort",
      type: "str",
      default: "rank",
      description: "Sort key: rank, activity, votes, creation",
    },
    { name: "limit", type: "int", default: 20, description: "Max questions" },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "score",
    "answers",
    "views",
    "isAnswered",
    "tags",
    "author",
    "createdAt",
    "lastActivityAt",
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireStackQuestionId(kwargs.id);
    const sort = requireSort(
      kwargs.sort,
      "rank",
      RELATED_SORTS,
      "related sort",
    );
    const limit = requireStackLimit(
      kwargs.limit,
      20,
      STACK_MAX_PAGE_SIZE,
      "related limit",
    );
    const envelope = await fetchStackJson<StackQuestion>(
      `/questions/${id}/related`,
      { order: "desc", sort, pagesize: limit },
      `stackoverflow related ${id}`,
    );
    return mapStackQuestionRows(
      stackItems(envelope, `stackoverflow related ${id}`).slice(0, limit),
    );
  },
});

cli({
  site: "stackoverflow",
  name: "tag",
  description: "List Stack Overflow questions tagged with a given tag",
  domain: "stackoverflow.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "tag",
      type: "str",
      required: true,
      positional: true,
      description: "Tag slug",
    },
    {
      name: "sort",
      type: "str",
      default: "activity",
      description: "Sort key: activity, votes, creation, hot, week, month",
    },
    { name: "limit", type: "int", default: 20, description: "Max questions" },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "score",
    "answers",
    "views",
    "isAnswered",
    "tags",
    "author",
    "createdAt",
    "lastActivityAt",
    "url",
  ],
  func: async (_page, kwargs) => {
    const tag = requireStackString(kwargs.tag, "tag").toLowerCase();
    const sort = requireSort(kwargs.sort, "activity", TAG_SORTS, "tag sort");
    const limit = requireStackLimit(
      kwargs.limit,
      20,
      STACK_MAX_PAGE_SIZE,
      "tag limit",
    );
    const envelope = await fetchStackJson<StackQuestion>(
      "/questions",
      { tagged: tag, order: "desc", sort, pagesize: limit },
      `stackoverflow tag ${tag}`,
    );
    return mapStackQuestionRows(
      stackItems(envelope, `stackoverflow tag ${tag}`).slice(0, limit),
    );
  },
});

cli({
  site: "stackoverflow",
  name: "user",
  description: "Find Stack Overflow users by display name",
  domain: "stackoverflow.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "Display name or substring to search",
    },
    { name: "limit", type: "int", default: 10, description: "Max users" },
  ],
  columns: [
    "userId",
    "displayName",
    "reputation",
    "goldBadges",
    "silverBadges",
    "bronzeBadges",
    "location",
    "createdAt",
    "lastAccessAt",
    "url",
  ],
  func: async (_page, kwargs) => {
    const name = requireStackString(kwargs.name, "name");
    const limit = requireStackLimit(
      kwargs.limit,
      10,
      STACK_MAX_PAGE_SIZE,
      "user limit",
    );
    const envelope = await fetchStackJson<StackUser>(
      "/users",
      { inname: name, order: "desc", sort: "reputation", pagesize: limit },
      "stackoverflow user",
    );
    return mapStackUserRows(
      stackItems(envelope, "stackoverflow user").slice(0, limit),
    );
  },
});
