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
} from "./envelope.js";

const MAX_STRING_LEN = 500;
const MAX_INLINE_JSON = 200;

/** Sanitize a string value so embedded `---` at line start doesn't break frontmatter. */
function sanitize(s: string): string {
  return s.replace(/^---/gm, "\\---");
}

/** Format a leaf value for a bullet list item. */
function formatValue(v: unknown): string {
  if (v === null) return "(null)";
  if (v === undefined) return "(undefined)";
  if (typeof v === "function") return "[Function]";
  if (Buffer.isBuffer(v)) return `[Buffer ${v.byteLength} bytes]`;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (typeof v === "object") {
    // Fast path: no cycles — JSON.stringify handles DAGs (shared refs) naturally.
    // Slow path: cycle detected — redo with a replacer that tracks the current
    // serialization ancestry via the holder object (`this` in the replacer).
    let json: string;
    try {
      json = JSON.stringify(v);
    } catch {
      // Circular structure detected. Use ancestry-tracking replacer.
      // `this` in the replacer is the holder object; we maintain a path map
      // from holder → key so we can reconstruct the ancestry Set on each call.
      const ancestors: object[] = [];
      json = JSON.stringify(v, function (this: unknown, _key, val) {
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
      });
    }
    if (json.length > MAX_INLINE_JSON) {
      return json.slice(0, MAX_INLINE_JSON) + "… (truncated)";
    }
    return json;
  }
  const s = String(v);
  if (typeof v === "string" && s.length > MAX_STRING_LEN) {
    return (
      sanitize(s.slice(0, MAX_STRING_LEN)) +
      `… (truncated, ${s.length} chars total)`
    );
  }
  return sanitize(s);
}

/** Render YAML frontmatter block. */
function renderFrontmatter(env: AgentEnvelope): string {
  const lines: string[] = ["---"];
  lines.push(`ok: ${env.ok}`);
  lines.push(`schema_version: "${env.schema_version}"`);
  lines.push(`command: ${env.command}`);
  lines.push(`duration_ms: ${env.meta.duration_ms}`);

  if (env.ok) {
    const meta = env.meta;
    if (meta.count !== undefined) lines.push(`count: ${meta.count}`);
    if (meta.surface !== undefined) lines.push(`surface: ${meta.surface}`);
    if (meta.adapter_version !== undefined)
      lines.push(`adapter_version: ${meta.adapter_version}`);
    if (meta.operator !== undefined) lines.push(`operator: ${meta.operator}`);
    if (meta.pagination?.next_cursor !== undefined)
      lines.push(`next_cursor: ${meta.pagination.next_cursor}`);
    if (meta.pagination?.has_more !== undefined)
      lines.push(`has_more: ${meta.pagination.has_more}`);
  } else {
    // error envelope: include surface if present, but NOT error fields
    const meta = env.meta;
    if (meta.surface !== undefined) lines.push(`surface: ${meta.surface}`);
    if (meta.adapter_version !== undefined)
      lines.push(`adapter_version: ${meta.adapter_version}`);
    if (meta.operator !== undefined) lines.push(`operator: ${meta.operator}`);
  }

  lines.push("---");
  return lines.join("\n");
}

/** Pick a display title from an item object. */
function pickTitle(item: unknown): string {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    for (const key of ["title", "name", "id"]) {
      if (obj[key] !== undefined && obj[key] !== null) {
        return String(obj[key]);
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
      lines.push(`- **${key}**: ${formatValue(obj[key])}`);
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
    bullets.push(`- **adapter_version**: ${meta.adapter_version}`);
  if (meta.surface !== undefined)
    bullets.push(`- **surface**: ${meta.surface}`);
  if (meta.operator !== undefined)
    bullets.push(`- **operator**: ${meta.operator}`);
  if (meta.pagination?.next_cursor !== undefined)
    bullets.push(`- **next_cursor**: ${meta.pagination.next_cursor}`);
  if (meta.pagination?.has_more !== undefined)
    bullets.push(`- **has_more**: ${meta.pagination.has_more}`);

  if (bullets.length === 0) return "";
  return ["## Context", "", ...bullets].join("\n");
}

/** Render ## Next Actions (only when pagination.has_more === true). */
function renderNextActionsSection(meta: AgentMeta): string {
  if (meta.pagination?.has_more !== true) return "";
  const cursor = meta.pagination?.next_cursor;
  const cursorStr = cursor !== undefined ? `\`${cursor}\`` : "(no cursor)";
  return [
    "## Next Actions",
    "",
    `- Fetch next page with cursor: ${cursorStr}`,
  ].join("\n");
}

/** Render ## Error section for error envelopes. */
function renderErrorSection(err: AgentError): string {
  const lines: string[] = ["## Error", ""];
  lines.push(`- **code**: ${err.code}`);
  lines.push(`- **message**: ${formatValue(err.message)}`);
  if (err.adapter_path !== undefined)
    lines.push(`- **adapter_path**: ${err.adapter_path}`);
  if (err.step !== undefined) lines.push(`- **step**: ${err.step}`);
  if (err.retryable !== undefined)
    lines.push(`- **retryable**: ${err.retryable}`);
  return lines.join("\n");
}

/** Render ## Suggestion (paragraph, no bullet). */
function renderSuggestionSection(err: AgentError): string {
  if (!err.suggestion) return "";
  return ["## Suggestion", "", err.suggestion].join("\n");
}

/** Render ## Alternatives (inline-code bullets). */
function renderAlternativesSection(err: AgentError): string {
  if (!err.alternatives || err.alternatives.length === 0) return "";
  const bullets = err.alternatives.map((a) => `- \`${a}\``);
  return ["## Alternatives", "", ...bullets].join("\n");
}

/** Assemble the success envelope body. */
function renderSuccess(env: AgentEnvelopeOk): string {
  const parts: string[] = [];
  parts.push(renderFrontmatter(env));
  parts.push(renderDataSection(env.data));

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
