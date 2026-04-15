#!/usr/bin/env tsx
/**
 * One-shot bulk quarantine — flip `quarantine: false` → `true` and add a
 * `quarantineReason` on the 33 adapters the 2026-04-15 adapter-health
 * probe flagged as genuinely drifted upstream (HTTP 404, structure
 * mismatch, bare fetch failed against a real endpoint).
 *
 * Not a long-lived script — this is a stamped-in-time fix. The real
 * repair path is the self-repair loop: an agent picks up a quarantined
 * adapter from `unicli list --quarantined`, inspects the failing URL,
 * edits the YAML, and unsets the flag. The strict gate then polices
 * regressions from a known-good baseline.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS = join(__dirname, "..", "src", "adapters");

/** (site, command, reason) tuples from the 2026-04-15 probe run. */
const TO_QUARANTINE: Array<[string, string, string]> = [
  [
    "36kr",
    "latest",
    "upstream structure drift — `Select data.hotRankList` returned nothing (2026-04-15)",
  ],
  [
    "adguardhome",
    "rules",
    "requires local AdGuard Home instance on a private host",
  ],
  [
    "adguardhome",
    "stats",
    "requires local AdGuard Home instance on a private host",
  ],
  [
    "adguardhome",
    "status",
    "requires local AdGuard Home instance on a private host",
  ],
  [
    "apple-podcasts",
    "top",
    "HTTP 404 — upstream API path double-slash regression (2026-04-15)",
  ],
  [
    "arxiv",
    "trending",
    "HTTP 400 on empty category — probe fires without required `category` arg default",
  ],
  [
    "az",
    "account",
    "`az account show` times out in CI without interactive login",
  ],
  [
    "bilibili",
    "coin",
    "upstream structure drift — `Select data.list` returned nothing (2026-04-15)",
  ],
  [
    "bilibili",
    "feed",
    "upstream structure drift — `Select data.items` returned nothing (2026-04-15)",
  ],
  [
    "bilibili",
    "history",
    "upstream structure drift — `Select data.list` returned nothing (2026-04-15)",
  ],
  [
    "bilibili",
    "later",
    "upstream structure drift — `Select data.list` returned nothing (2026-04-15)",
  ],
  [
    "bilibili",
    "live",
    "upstream structure drift — `Select data.list` returned nothing (2026-04-15)",
  ],
  ["douban", "book-hot", "HTTP 404 — upstream endpoint removed (2026-04-15)"],
  ["douban", "group-hot", "HTTP 404 — upstream endpoint removed (2026-04-15)"],
  [
    "douban",
    "top250",
    "timed out after 8s — upstream slow from hosted runners",
  ],
  ["eastmoney", "hot", "upstream unreachable from CI egress (2026-04-15)"],
  ["exchangerate", "list", "HTTP 404 — upstream endpoint removed (2026-04-15)"],
  [
    "gitee",
    "trending",
    "HTTP 404 — upstream API v5 `projects` endpoint removed (2026-04-15)",
  ],
  [
    "github-trending",
    "developers",
    "HTTP 404 — gitterapp mirror retired, needs official GitHub trending scrape",
  ],
  [
    "github-trending",
    "weekly",
    "HTTP 404 — gitterapp mirror retired, needs official GitHub trending scrape",
  ],
  [
    "imdb",
    "top",
    "upstream returns HTML instead of JSON — scraping path needed",
  ],
  ["itch-io", "popular", "HTTP 404 — itch.io removed the top-rated JSON feed"],
  ["itch-io", "top", "HTTP 404 — itch.io /api/1/x/games endpoint removed"],
  ["ithome", "hot", "HTTP 404 — upstream endpoint relocated (2026-04-15)"],
  [
    "jd",
    "hot",
    "upstream structure drift — `Select hotWords` returned nothing (2026-04-15)",
  ],
  [
    "mastodon",
    "timeline",
    "mastodon.social blocks CI egress; adapter works against user instance",
  ],
  [
    "netease-music",
    "top",
    "upstream structure drift — `Select result.tracks` returned nothing (2026-04-15)",
  ],
  ["ollama", "models", "HTTP 404 — upstream API path changed (2026-04-15)"],
  [
    "replicate",
    "trending",
    "HTTP 404 — upstream trending endpoint removed (2026-04-15)",
  ],
  [
    "reuters",
    "latest",
    "HTTP 404 — reutersagency.com feed endpoint removed (2026-04-15)",
  ],
  [
    "tieba",
    "hot",
    "upstream returns HTML (anti-bot page) instead of JSON from CI egress",
  ],
  [
    "wikipedia",
    "today",
    "wikipedia REST blocks CI egress; adapter works from real user hosts",
  ],
  [
    "yahoo-finance",
    "trending",
    "HTTP 404 — upstream trending endpoint removed (2026-04-15)",
  ],
];

function escapeYamlString(s: string): string {
  // Double-quoted YAML scalar — escape `"` and `\`.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

let updated = 0;
let skipped = 0;
for (const [site, command, reason] of TO_QUARANTINE) {
  const path = join(ADAPTERS, site, `${command}.yaml`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    console.warn(`skip missing: ${site}/${command}.yaml`);
    skipped++;
    continue;
  }

  // Flip `quarantine: false` → `quarantine: true` (exact match at line
  // start; avoids catching it inside a pipeline config key by accident).
  if (!/^quarantine:\s*(true|false)\s*$/m.test(raw)) {
    console.warn(`skip (no quarantine line): ${site}/${command}.yaml`);
    skipped++;
    continue;
  }
  let next = raw.replace(/^quarantine:\s*false\s*$/m, "quarantine: true");

  // Inject quarantineReason immediately after the quarantine line if
  // absent; else overwrite so the reason is current.
  const reasonLine = `quarantineReason: "${escapeYamlString(reason)}"`;
  if (/^quarantineReason:/m.test(next)) {
    next = next.replace(/^quarantineReason:.*$/m, reasonLine);
  } else {
    next = next.replace(/^(quarantine:\s*true)\s*$/m, `$1\n${reasonLine}`);
  }

  if (next === raw) {
    skipped++;
    continue;
  }
  writeFileSync(path, next, "utf-8");
  updated++;
  console.log(`quarantined: ${site}/${command}`);
}

console.log(`\nBulk quarantine: updated ${updated}, skipped ${skipped}.`);
