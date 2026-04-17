/**
 * Agent-Native Markdown renderer — turns an AgentEnvelope into a
 * frontmatter + sectioned markdown document for LLM consumption.
 *
 * Output contract:
 *  - YAML frontmatter block (always)
 *  - ## Data (success only)
 *  - ## Context (success, conditional)
 *  - ## Next Actions (success, pagination-conditional)
 *  - ## Error / ## Suggestion / ## Alternatives (error only)
 *  - Trailing newline
 */

import type {
  AgentEnvelope,
  AgentEnvelopeOk,
  AgentEnvelopeErr,
  AgentMeta,
  AgentError,
  AgentContent,
} from "./envelope.js";

const MAX_STRING_LEN = 500;
const MAX_INLINE_JSON = 200;

/**
 * Sanitize for multi-line block contexts (e.g. Suggestion paragraph).
 * Preserves newlines; only escapes line-start `---` to prevent frontmatter injection.
 */
function sanitizeBlock(s: string): string {
  return s.replace(/^---/gm, "\\---");
}

/**
 * Sanitize for single-line inline contexts (frontmatter values, bullet
 * keys/values, titles).  Collapses embedded newlines to a space and escapes
 * a leading `---` so the value cannot break YAML frontmatter.
 */
function sanitizeInline(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/^---/, "\\---")
    .trim();
}

/** Format a leaf value for a bullet list item. */
function formatValue(v: unknown): string {
  if (v === null) return "(null)";
  if (v === undefined) return "(undefined)";
  if (typeof v === "function") return "[Function]";
  if (Buffer.isBuffer(v)) return `[Buffer ${v.byteLength} bytes]`;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return `[${v.length} items]`;
  // FIX B3: BigInt explicit early-return — JSON.stringify always throws on BigInt.
  if (typeof v === "bigint") return `${v.toString()}n`;
  if (typeof v === "object" && v !== null) {
    // Fast path: no cycles — JSON.stringify handles DAGs (shared refs) naturally.
    // Slow path: cycle detected — redo with a replacer that tracks the current
    // serialization ancestry via the holder object (`this` in the replacer).
    // FIX B1: outer catch handles objects whose toJSON() throws (unconditional).
    let json: string;
    try {
      json = JSON.stringify(v);
    } catch {
      // Either a circular structure or a throwing toJSON. Try ancestry-tracking
      // replacer. `this` in the replacer is the holder object; we maintain a path
      // map from holder → key so we can reconstruct the ancestry Set on each call.
      try {
        const ancestors: object[] = [];
        json =
          JSON.stringify(v, function (this: unknown, _key, val) {
            if (typeof val === "object" && val !== null) {
              // Remove any ancestors that are no longer in this holder's chain.
              const holderIdx = ancestors.indexOf(this as object);
              if (holderIdx !== -1) {
                ancestors.splice(holderIdx + 1);
              } else {
                ancestors.length = 0;
              }
              if (ancestors.includes(val as object)) return "[Circular]";
              ancestors.push(val as object);
            }
            return val;
          }) ?? "[unserializable]";
      } catch {
        // toJSON throws even inside replacer — give up gracefully.
        return "[unserializable]";
      }
    }
    if (typeof json !== "string") return "[unserializable]";
    if (json.length > MAX_INLINE_JSON) {
      return json.slice(0, MAX_INLINE_JSON) + "… (truncated)";
    }
    return json;
  }
  if (typeof v === "string") {
    const truncated =
      v.length > MAX_STRING_LEN
        ? v.slice(0, MAX_STRING_LEN) + `… (truncated, ${v.length} chars total)`
        : v;
    // FIX B2: collapse newlines so multiline strings don't break bullet structure.
    return truncated.replace(/[\r\n]+/g, " ");
  }
  return String(v);
}

/** Render YAML frontmatter block. */
function renderFrontmatter(env: AgentEnvelope): string {
  const lines: string[] = ["---"];
  lines.push(`ok: ${env.ok}`);
  lines.push(`schema_version: "${env.schema_version}"`);
  // FIX B2: command value is inline — sanitizeInline.
  lines.push(`command: ${sanitizeInline(env.command)}`);
  lines.push(`duration_ms: ${env.meta.duration_ms}`);

  if (env.ok) {
    const meta = env.meta;
    if (meta.count !== undefined) lines.push(`count: ${meta.count}`);
    if (meta.surface !== undefined)
      lines.push(`surface: ${sanitizeInline(meta.surface)}`);
    if (meta.adapter_version !== undefined)
      // FIX B2: adapter_version with embedded newline must not break YAML block.
      lines.push(`adapter_version: ${sanitizeInline(meta.adapter_version)}`);
    if (meta.operator !== undefined)
      lines.push(`operator: ${sanitizeInline(meta.operator)}`);
    if (meta.pagination?.next_cursor !== undefined)
      // FIX B2: cursor value is inline.
      lines.push(
        `next_cursor: ${sanitizeInline(String(meta.pagination.next_cursor))}`,
      );
    if (meta.pagination?.has_more !== undefined)
      lines.push(`has_more: ${meta.pagination.has_more}`);
  } else {
    // error envelope: include surface if present, but NOT error fields
    const meta = env.meta;
    if (meta.surface !== undefined)
      lines.push(`surface: ${sanitizeInline(meta.surface)}`);
    if (meta.adapter_version !== undefined)
      lines.push(`adapter_version: ${sanitizeInline(meta.adapter_version)}`);
    if (meta.operator !== undefined)
      lines.push(`operator: ${sanitizeInline(meta.operator)}`);
  }

  lines.push("---");
  return lines.join("\n");
}

/**
 * Pick a display title from an item object.
 *
 * Priority: `title` → `name` → `id` → `question` → `excerpt` → `summary` → "Item".
 *
 * The `question` / `excerpt` / `summary` fallbacks were added in v0.213.1 for
 * shapes like `zhihu.answers` that carry the post body in `question` + `excerpt`
 * without a `title` or `name`; before this fallback every row rendered as
 * `### N · Item`, hiding the row's distinguishing content.
 */
function pickTitle(item: unknown): string {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    for (const key of [
      "title",
      "name",
      "id",
      "question",
      "excerpt",
      "summary",
    ]) {
      if (obj[key] !== undefined && obj[key] !== null) {
        // FIX B2: title is placed in a ### header line — must be single-line.
        return sanitizeInline(String(obj[key]));
      }
    }
  }
  return "Item";
}

/** Render a single array item as ### N · title + bullet list. */
function renderItem(item: unknown, index: number): string {
  const title = pickTitle(item);
  const lines: string[] = [`### ${index} · ${title}`, ""];
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      // FIX B2: key appears inline in a bullet — sanitizeInline.
      lines.push(`- **${sanitizeInline(key)}**: ${formatValue(obj[key])}`);
    }
  } else {
    lines.push(`- **value**: ${formatValue(item)}`);
  }
  return lines.join("\n");
}

/** Render the ## Data section for a success envelope. */
function renderDataSection(data: unknown[] | Record<string, unknown>): string {
  const lines: string[] = ["## Data", ""];

  if (Array.isArray(data)) {
    if (data.length === 0) {
      lines.push("_(no data)_");
    } else {
      for (let i = 0; i < data.length; i++) {
        lines.push(renderItem(data[i], i + 1));
        if (i < data.length - 1) lines.push("");
      }
    }
  } else {
    const keys = Object.keys(data);
    if (keys.length === 0) {
      lines.push("_(no data)_");
    } else {
      for (const key of keys) {
        lines.push(`- **${key}**: ${formatValue(data[key])}`);
      }
    }
  }

  return lines.join("\n");
}

/** Render the ## Context section (omitted if no bullets). */
function renderContextSection(meta: AgentMeta): string {
  const bullets: string[] = [];
  if (meta.adapter_version !== undefined)
    // FIX B2: context bullet values are inline.
    bullets.push(
      `- **adapter_version**: ${sanitizeInline(meta.adapter_version)}`,
    );
  if (meta.surface !== undefined)
    bullets.push(`- **surface**: ${sanitizeInline(meta.surface)}`);
  if (meta.operator !== undefined)
    bullets.push(`- **operator**: ${sanitizeInline(meta.operator)}`);
  if (meta.pagination?.next_cursor !== undefined)
    bullets.push(
      `- **next_cursor**: ${sanitizeInline(String(meta.pagination.next_cursor))}`,
    );
  if (meta.pagination?.has_more !== undefined)
    bullets.push(`- **has_more**: ${meta.pagination.has_more}`);

  if (bullets.length === 0) return "";
  return ["## Context", "", ...bullets].join("\n");
}

/**
 * Render ## Content section from optional `envelope.content[]`.
 *
 * Each block renders as a bullet:
 *  - `text`      → `- text: "<preview>"`
 *  - `image`     → `- image: <uri>` (or `(inline base64 data)` when `uri` is absent)
 *  - `resource`  → `- resource: <uri>` (file:// uris common for download outputs)
 *
 * Added in v0.213.1 (Task T12 / Fix #14) — the field shipped in v0.213.0 but
 * was never populated, so the md renderer ignored it. `emit_content: true` in
 * a YAML adapter now plumbs download-step file metadata into this section.
 */
function renderContentSection(content: AgentContent[] | undefined): string {
  if (!content || content.length === 0) return "";
  const bullets: string[] = [];
  for (const c of content) {
    if (c.type === "text") {
      const preview = sanitizeInline(String(c.text ?? ""));
      bullets.push(`- **text**: ${formatValue(preview)}`);
    } else if (c.type === "image") {
      const where = c.uri
        ? sanitizeInline(c.uri)
        : c.data
          ? "(inline base64 data)"
          : "(empty)";
      bullets.push(`- **image**: ${where}`);
    } else {
      // resource
      const where = c.uri ? sanitizeInline(c.uri) : "(empty)";
      bullets.push(`- **resource**: ${where}`);
    }
  }
  return ["## Content", "", ...bullets].join("\n");
}

/** Render ## Next Actions (only when pagination.has_more === true). */
function renderNextActionsSection(meta: AgentMeta): string {
  if (meta.pagination?.has_more !== true) return "";
  const cursor = meta.pagination?.next_cursor;
  // FIX B2: cursor in inline code span — sanitizeInline.
  const cursorStr =
    cursor !== undefined
      ? `\`${sanitizeInline(String(cursor))}\``
      : "(no cursor)";
  return [
    "## Next Actions",
    "",
    `- Fetch next page with cursor: ${cursorStr}`,
  ].join("\n");
}

/** Render ## Error section for error envelopes. */
function renderErrorSection(err: AgentError): string {
  const lines: string[] = ["## Error", ""];
  // FIX B2: error fields are inline bullet values — sanitizeInline.
  lines.push(`- **code**: ${sanitizeInline(err.code)}`);
  lines.push(`- **message**: ${formatValue(err.message)}`);
  if (err.adapter_path !== undefined)
    lines.push(`- **adapter_path**: ${sanitizeInline(err.adapter_path)}`);
  if (err.step !== undefined) lines.push(`- **step**: ${err.step}`);
  if (err.retryable !== undefined)
    lines.push(`- **retryable**: ${err.retryable}`);
  return lines.join("\n");
}

/** Render ## Suggestion (paragraph, no bullet). */
function renderSuggestionSection(err: AgentError): string {
  if (!err.suggestion) return "";
  // FIX B2: Suggestion is a multi-line paragraph — sanitizeBlock preserves newlines.
  return ["## Suggestion", "", sanitizeBlock(err.suggestion)].join("\n");
}

/** Render ## Alternatives (inline-code bullets). */
function renderAlternativesSection(err: AgentError): string {
  if (!err.alternatives || err.alternatives.length === 0) return "";
  // FIX B2: alternative values appear inside inline code — sanitizeInline.
  const bullets = err.alternatives.map((a) => `- \`${sanitizeInline(a)}\``);
  return ["## Alternatives", "", ...bullets].join("\n");
}

/** Assemble the success envelope body. */
function renderSuccess(env: AgentEnvelopeOk): string {
  const parts: string[] = [];
  parts.push(renderFrontmatter(env));
  parts.push(renderDataSection(env.data));

  const contentSection = renderContentSection(env.content);
  if (contentSection) parts.push(contentSection);

  const context = renderContextSection(env.meta);
  if (context) parts.push(context);

  const nextActions = renderNextActionsSection(env.meta);
  if (nextActions) parts.push(nextActions);

  return parts.join("\n\n") + "\n";
}

/** Assemble the error envelope body. */
function renderError(env: AgentEnvelopeErr): string {
  const parts: string[] = [];
  parts.push(renderFrontmatter(env));
  parts.push(renderErrorSection(env.error));

  const contentSection = renderContentSection(env.content);
  if (contentSection) parts.push(contentSection);

  const suggestion = renderSuggestionSection(env.error);
  if (suggestion) parts.push(suggestion);

  const alternatives = renderAlternativesSection(env.error);
  if (alternatives) parts.push(alternatives);

  return parts.join("\n\n") + "\n";
}

/**
 * Render an AgentEnvelope as agent-native markdown.
 *
 * Pure function — no side effects. Output always ends with a single `\n`.
 */
export function renderMd(envelope: AgentEnvelope): string {
  if (envelope.ok) {
    return renderSuccess(envelope);
  } else {
    return renderError(envelope);
  }
}
