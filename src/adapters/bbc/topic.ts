/**
 * @owner   src/adapters/bbc/topic.ts
 * @does    Register agent-facing BBC topic RSS command.
 * @needs   feeds.bbci.co.uk public RSS feeds, topic whitelist, conservative RSS parsing.
 * @feeds   surface coverage ledger, BBC section headline discovery.
 * @breaks  BBC RSS envelope drift, loose topic parsing, or silent empty feeds hide news coverage failures.
 */

import { cli, Strategy } from "../../registry.js";

const BBC_FEED_BASE = "https://feeds.bbci.co.uk/news";
const TOPICS = [
  "world",
  "business",
  "politics",
  "health",
  "education",
  "science_and_environment",
  "technology",
  "entertainment_and_arts",
] as const;

type BbcTopic = (typeof TOPICS)[number];

interface RssItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  guid: string;
}

export function requireBbcLimit(value: unknown, fallback = 20): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error("bbc limit must be an integer in [1, 50].");
  }
  return n;
}

export function requireBbcTopic(value: unknown): BbcTopic {
  const topic = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!TOPICS.includes(topic as BbcTopic)) {
    throw new Error(`bbc topic "${String(value)}" is not supported.`);
  }
  return topic as BbcTopic;
}

export function decodeBbcEntities(value: unknown): string {
  return String(value ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export function extractRssTag(block: string, tag: string): string {
  const cdata = block.match(
    new RegExp(
      `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
    ),
  );
  if (cdata) return cdata[1];
  const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return plain ? plain[1] : "";
}

export function parseBbcRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      title: decodeBbcEntities(extractRssTag(block, "title")).trim(),
      description: decodeBbcEntities(
        extractRssTag(block, "description"),
      ).trim(),
      link: decodeBbcEntities(extractRssTag(block, "link")).trim(),
      pubDate: decodeBbcEntities(extractRssTag(block, "pubDate")).trim(),
      guid: decodeBbcEntities(extractRssTag(block, "guid")).trim(),
    });
  }
  return items;
}

export function bbcPubDateToIso(value: unknown): string {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

async function fetchBbcRss(topic: BbcTopic): Promise<string> {
  const response = await fetch(`${BBC_FEED_BASE}/${topic}/rss.xml`, {
    headers: {
      "User-Agent": "unicli-bbc/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/rss+xml, application/xml",
    },
  });
  if (!response.ok)
    throw new Error(`bbc topic ${topic} returned HTTP ${response.status}.`);
  return response.text();
}

cli({
  site: "bbc",
  name: "topic",
  description: "BBC News headlines for a specific section",
  domain: "feeds.bbci.co.uk",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "topic",
      type: "str",
      required: true,
      positional: true,
      choices: [...TOPICS],
      description: "BBC section name",
    },
    { name: "limit", type: "int", default: 20, description: "Max headlines" },
  ],
  columns: ["rank", "title", "description", "pubDate", "url"],
  func: async (_page, kwargs) => {
    const topic = requireBbcTopic(kwargs.topic);
    const limit = requireBbcLimit(kwargs.limit);
    const items = parseBbcRssItems(await fetchBbcRss(topic));
    if (items.length === 0)
      throw new Error(`BBC ${topic} feed returned no items.`);
    return items.slice(0, limit).map((item, index) => ({
      rank: index + 1,
      title: item.title,
      description: item.description,
      pubDate: bbcPubDateToIso(item.pubDate),
      url: item.link,
    }));
  },
});
