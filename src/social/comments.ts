/**
 * @owner   Social comment model.
 * @does    Converts platform-specific comment rows into stable hierarchical rows.
 * @needs   Adapter comment rows in either legacy flat form or explicit parent-id form.
 * @feeds   Social adapters, tests, JSON consumers, and comment-thread analysis.
 * @breaks  Comment trees lose hierarchy if a platform omits both parent ids and reply-to hints.
 */

export interface NormalizeCommentOptions {
  platform: string;
  contentId: string;
}

export interface SocialCommentRow extends Record<string, unknown> {
  platform: string;
  content_id: string;
  comment_id: string;
  parent_id: string;
  depth: number;
  path: string;
  author: string;
  text: string;
  likes: number;
  replies: number;
  created: string;
}

function stringField(
  row: Record<string, unknown>,
  names: string[],
  fallback = "",
): string {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return fallback;
}

function numberField(row: Record<string, unknown>, names: string[]): number {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replace(/,/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function segment(index: number): string {
  return String(index).padStart(4, "0");
}

export function normalizeCommentRows(
  rows: Array<Record<string, unknown>>,
  options: NormalizeCommentOptions,
): SocialCommentRow[] {
  const byAuthor = new Map<string, string>();
  const byId = new Map<string, SocialCommentRow>();
  const childCounts = new Map<string, number>();
  let lastRootId = "";

  return rows.map((row, index) => {
    const commentId =
      stringField(row, ["comment_id", "id", "rpid", "cid"]) ||
      `${options.platform}:${options.contentId}:${index + 1}`;
    const author = stringField(row, [
      "author",
      "user",
      "user_name",
      "author_name",
      "uname",
    ]);
    let parentId = stringField(row, [
      "parent_id",
      "parent",
      "root_id",
      "reply_to_comment_id",
    ]);
    const replyTo = stringField(row, ["reply_to"]);
    if (!parentId && row.is_reply === true && replyTo) {
      parentId = byAuthor.get(replyTo) ?? "";
    }
    if (!parentId && row.is_reply === true) {
      parentId = lastRootId;
    }

    const parent = parentId ? byId.get(parentId) : undefined;
    const parentKey = parent?.comment_id ?? "";
    const siblingIndex = (childCounts.get(parentKey) ?? 0) + 1;
    childCounts.set(parentKey, siblingIndex);
    const depth = parent ? parent.depth + 1 : 0;
    const path = parent
      ? `${parent.path}.${segment(siblingIndex)}`
      : segment(siblingIndex);
    const normalized: SocialCommentRow = {
      ...row,
      platform: options.platform,
      content_id: options.contentId,
      comment_id: commentId,
      parent_id: parent?.comment_id ?? "",
      depth,
      path,
      author,
      text: stringField(row, ["text", "content", "body", "message"]),
      likes: numberField(row, ["likes", "like", "like_count", "score"]),
      replies: numberField(row, [
        "replies",
        "reply_count",
        "rcount",
        "child_comment_count",
      ]),
      created: stringField(row, ["created", "created_at", "time", "date"]),
    };

    byId.set(commentId, normalized);
    if (author) byAuthor.set(author, commentId);
    if (!normalized.parent_id) lastRootId = commentId;
    return normalized;
  });
}
