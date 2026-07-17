/**
 * @owner       src::engine::html-to-markdown
 * @does        Converts upstream HTML into content-focused Markdown while removing non-content DOM branches.
 * @needs       cheerio and turndown
 * @feeds       pipeline html_to_md step and one-shot extract command
 * @breaks      Leaking navigation, executable branches, or framework serialization placeholders pollutes Agent context and hides the document body.
 * @invariants  Conversion is deterministic for one HTML string, prefers semantic content roots, removes framework serialization placeholders, and never executes markup.
 * @side-effects None.
 * @perf        O(N) in input size.
 * @concurrency safe
 * @test        tests/unit/engine-features.test.ts, tests/unit/commands/extract.test.ts
 * @stability   stable
 * @since       2026-07-17
 */

import TurndownService from "turndown";
import { load, type CheerioAPI } from "cheerio";

const NON_CONTENT_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "nav",
  "aside",
  "footer",
  "form",
  "dialog",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  ".sidebar",
  ".side-nav",
  ".sidenav",
  ".toc",
  ".table-of-contents",
  ".breadcrumb",
  ".breadcrumbs",
] as const;

function largestRoot($: CheerioAPI, selector: string) {
  let largest = $(selector).first();
  let largestLength = largest.text().replace(/\s+/g, " ").trim().length;
  $(selector).each((_index, element) => {
    const candidate = $(element);
    const candidateLength = candidate.text().replace(/\s+/g, " ").trim().length;
    if (candidateLength > largestLength) {
      largest = candidate;
      largestLength = candidateLength;
    }
  });
  return largestLength > 0 ? largest : largest.slice(0, 0);
}

function contentRoot($: CheerioAPI) {
  for (const selector of ["article", "main", '[role="main"]']) {
    const root = largestRoot($, selector);
    if (root.length > 0) return root;
  }
  return $("body").first();
}

export function htmlToMarkdown(html: string): string {
  const $ = load(html);
  const title = $("head title").first().text().replace(/\s+/g, " ").trim();
  const hasSerializedObjectPlaceholder = $("body")
    .text()
    .includes("[object Object]");
  $(NON_CONTENT_SELECTORS.join(",")).remove();
  $("*")
    .contents()
    .each((_index, node) => {
      if (
        node.type === "text" &&
        (/^(?:\s*\[object Object\]\s*)+$/i.test(node.data) ||
          (hasSerializedObjectPlaceholder &&
            /^(?:\s*(?:\[object Object\]|undefined)\s*)+$/i.test(node.data)) ||
          /^\s*(?:back to top|返回顶部)\s*$/i.test(node.data))
      ) {
        $(node).remove();
      }
    });
  $("a").each((_index, element) => {
    const link = $(element);
    const href = link.attr("href") ?? "";
    const classes = link.attr("class") ?? "";
    const label = `${link.attr("title") ?? ""} ${link.attr("aria-label") ?? ""}`;
    const text = link.text().trim();
    if (
      /\[object Object\]|%5Bobject(?:%20|\+)Object%5D|undefined/i.test(href)
    ) {
      link.replaceWith(link.text());
    } else if (
      /(?:^|\s)(?:anchor|headerlink|permalink)(?:\s|$)/i.test(classes) ||
      /(?:link to this heading|permalink)/i.test(label) ||
      /^(?:#|back to top|返回顶部)$/i.test(text)
    ) {
      link.remove();
    }
  });

  const root = contentRoot($);
  const contentHtml = root.html() ?? $.html();
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  let markdown = turndown.turndown(contentHtml).trim();
  if (
    title &&
    !markdown.toLocaleLowerCase().includes(title.toLocaleLowerCase())
  ) {
    markdown = `# ${title}\n\n${markdown}`.trim();
  }
  return markdown;
}
