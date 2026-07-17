/**
 * @owner src/engine/steps/parse-rss.ts
 * @does Parses RSS and Atom entries, including repeated nested fields declared with dot paths.
 * @needs Pipeline context, XML text normalization, step registry.
 * @feeds RSS/Atom adapter pipelines including arXiv scholarly search.
 * @breaks Lossy repeated-field extraction drops authors and other structured Atom metadata.
 * @invariants Simple field tags preserve first-match behavior; dot paths join every matching nested leaf in document order.
 * @side-effects Registers the parse_rss step at module load.
 * @perf O(entries * configured fields * XML length).
 * @concurrency Safe after module registration.
 * @test tests/unit/pipe-filters.test.ts, src/adapters/arxiv/search.test.ts
 * @stability stable
 * @since 2026-07-17
 */

import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { normalizeXmlText } from "../text-normalize.js";

export interface RssConfig {
  fields?: Record<string, string>;
}

export function stepParseRss(
  ctx: PipelineContext,
  config: RssConfig | undefined,
): PipelineContext {
  const xml = String(ctx.data ?? "");
  const items: Record<string, string>[] = [];

  // Support both RSS 2.0 (<item>) and Atom (<entry>) formats
  const isAtom = xml.includes("<entry>");
  const itemRegex = isAtom
    ? /<entry>([\s\S]*?)<\/entry>/g
    : /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    if (config?.fields) {
      const row: Record<string, string> = {};
      for (const [key, tag] of Object.entries(config.fields)) {
        row[key] = extractXmlField(block, tag);
      }
      if (row.link && !row.url) row.url = row.link;
      items.push(row);
    } else if (isAtom) {
      const linkMatch = block.match(
        /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/,
      );
      const linkHref = normalizeXmlText(
        linkMatch?.[1] ??
          block.match(/<link[^>]*href=["']([^"']+)["']/)?.[1] ??
          "",
      );
      items.push({
        title: extractXmlCdata(block, "title"),
        description:
          extractXmlCdata(block, "content") ||
          extractXmlCdata(block, "summary"),
        link: linkHref,
        url: linkHref,
        pubDate:
          extractXmlTag(block, "published") || extractXmlTag(block, "updated"),
        guid: extractXmlTag(block, "id"),
      });
    } else {
      items.push({
        title: extractXmlCdata(block, "title"),
        description: extractXmlCdata(block, "description"),
        link: extractXmlTag(block, "link"),
        url: extractXmlTag(block, "link"),
        pubDate: extractXmlTag(block, "pubDate"),
        guid: extractXmlTag(block, "guid"),
      });
    }
  }

  return { ...ctx, data: items };
}

function extractXmlCdata(xml: string, tag: string): string {
  const cdataMatch = xml.match(
    new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`),
  );
  if (cdataMatch) return normalizeXmlText(cdataMatch[1]);
  return extractXmlTag(xml, tag);
}

function extractXmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? normalizeXmlText(m[1]) : "";
}

function extractXmlField(xml: string, field: string): string {
  const path = field.split(".").filter(Boolean);
  if (path.length <= 1) return extractXmlTag(xml, field);
  let fragments = [xml];
  for (const tag of path) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(
      `<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`,
      "g",
    );
    fragments = fragments.flatMap((fragment) =>
      [...fragment.matchAll(expression)].map((match) => match[1]),
    );
  }
  return fragments.map(normalizeXmlText).filter(Boolean).join(", ");
}

registerStep("parse_rss", stepParseRss as StepHandler);
