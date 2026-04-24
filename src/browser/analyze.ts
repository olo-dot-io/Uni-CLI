import type { AdapterManifest } from "../types.js";

export interface PageSignals {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  cookieNames: string[];
  networkEntries: Array<{
    url: string;
    status: number;
    contentType: string;
    bodyPreview: string | null;
  }>;
  initialState: {
    __INITIAL_STATE__: boolean;
    __NUXT__: boolean;
    __NEXT_DATA__: boolean;
    __APOLLO_STATE__: boolean;
  };
}

export type AntiBotVendor = "aliyun_waf" | "cloudflare" | "akamai" | "geetest";

export interface AntiBotVerdict {
  detected: boolean;
  vendor: AntiBotVendor | null;
  evidence: string[];
  implication: string;
}

const WAF_SIGNATURES: Array<{
  vendor: AntiBotVendor;
  priority: number;
  cookiePatterns: RegExp[];
  bodyPatterns: RegExp[];
  implication: string;
}> = [
  {
    vendor: "cloudflare",
    priority: 100,
    cookiePatterns: [/^__cf_bm$/, /^cf_clearance$/, /^__cfduid$/],
    bodyPatterns: [/Cloudflare Ray ID/i, /Checking your browser/i, /cf-chl-/i],
    implication:
      "Cloudflare bot check. Start from a real browser session; validate endpoints in browser context before deciding whether Node-side fetch is reusable.",
  },
  {
    vendor: "aliyun_waf",
    priority: 90,
    cookiePatterns: [/^acw_sc__v2$/, /^acw_tc$/, /^ssxmod_itna/],
    bodyPatterns: [/arg1\s*=\s*['"][0-9A-F]{30,}/, /\/ntc_captcha\//i],
    implication:
      "Aliyun WAF detected. Probe in browser context first; only promote to cookie/header fetch after the live endpoint returns target data.",
  },
  {
    vendor: "akamai",
    priority: 80,
    cookiePatterns: [/^_abck$/, /^bm_sz$/, /^bm_sv$/],
    bodyPatterns: [/akamai/i],
    implication:
      "Akamai Bot Manager detected. Validate in browser context, then reuse cookies/headers only if direct fetch keeps returning data.",
  },
  {
    vendor: "geetest",
    priority: 70,
    cookiePatterns: [],
    bodyPatterns: [/geetest/i, /gt_captcha/i],
    implication:
      "Geetest captcha detected. Use a UI or human-in-loop strategy; do not fake a reusable API adapter from this capture alone.",
  },
];

export function detectAntiBot(signals: PageSignals): AntiBotVerdict {
  const allEvidence = new Set<string>();
  let best: {
    vendor: AntiBotVendor;
    score: number;
    implication: string;
  } | null = null;

  for (const sig of WAF_SIGNATURES) {
    let hits = 0;
    for (const pat of sig.cookiePatterns) {
      for (const cookie of signals.cookieNames) {
        if (pat.test(cookie)) {
          hits += 1;
          allEvidence.add(`cookie:${cookie}`);
        }
      }
    }
    for (const pat of sig.bodyPatterns) {
      for (const entry of signals.networkEntries) {
        if (entry.bodyPreview && pat.test(entry.bodyPreview)) {
          hits += 1;
          allEvidence.add(`body:${entry.url}`);
          break;
        }
      }
    }
    if (hits > 0) {
      const score = hits * 1000 + sig.priority;
      if (!best || score > best.score) {
        best = { vendor: sig.vendor, score, implication: sig.implication };
      }
    }
  }

  if (!best) {
    return {
      detected: false,
      vendor: null,
      evidence: [],
      implication:
        "No known anti-bot signatures. Try direct cookie/header fetch after checking `unicli browser network`.",
    };
  }

  return {
    detected: true,
    vendor: best.vendor,
    evidence: Array.from(allEvidence).sort(),
    implication: best.implication,
  };
}

export type Pattern = "A" | "B" | "C" | "D" | "E";

export interface PatternVerdict {
  pattern: Pattern;
  reason: string;
  json_responses: number;
  auth_failures: number;
  websocket_responses: number;
}

function isApiLike(entry: PageSignals["networkEntries"][number]): boolean {
  if (/json/i.test(entry.contentType)) return true;
  if (entry.status === 401 || entry.status === 403) return true;
  return /\/(api|ajax|graphql|rest|xhr)\b|\.json(?:$|\?)/i.test(entry.url);
}

function isWebSocketLike(
  entry: PageSignals["networkEntries"][number],
): boolean {
  return (
    /^wss?:\/\//i.test(entry.url) ||
    /websocket|event-stream/i.test(entry.contentType)
  );
}

export function classifyPattern(signals: PageSignals): PatternVerdict {
  const jsonResponses = signals.networkEntries.filter((e) =>
    /json/i.test(e.contentType),
  ).length;
  const authFailures = signals.networkEntries.filter(
    (e) => (e.status === 401 || e.status === 403) && isApiLike(e),
  ).length;
  const websocketResponses =
    signals.networkEntries.filter(isWebSocketLike).length;
  const stateGlobals = Object.entries(signals.initialState)
    .filter(([, present]) => present)
    .map(([name]) => name);

  if (authFailures > 0) {
    return {
      pattern: "D",
      reason: `${authFailures} auth-failing API response(s) seen`,
      json_responses: jsonResponses,
      auth_failures: authFailures,
      websocket_responses: websocketResponses,
    };
  }
  if (stateGlobals.length > 0) {
    return {
      pattern: "B",
      reason: `SSR state global present: ${stateGlobals.join(", ")}`,
      json_responses: jsonResponses,
      auth_failures: authFailures,
      websocket_responses: websocketResponses,
    };
  }
  if (websocketResponses > 0) {
    return {
      pattern: "E",
      reason: `${websocketResponses} websocket/stream response(s) observed`,
      json_responses: jsonResponses,
      auth_failures: authFailures,
      websocket_responses: websocketResponses,
    };
  }
  if (jsonResponses > 0) {
    return {
      pattern: "A",
      reason: `${jsonResponses} JSON XHR/fetch response(s) observed`,
      json_responses: jsonResponses,
      auth_failures: authFailures,
      websocket_responses: websocketResponses,
    };
  }
  return {
    pattern: "C",
    reason: "No JSON XHR, SSR state, or stream signal observed",
    json_responses: jsonResponses,
    auth_failures: authFailures,
    websocket_responses: websocketResponses,
  };
}

export interface NearestAdapter {
  site: string;
  example_commands: string[];
  reason: string;
}

export function findNearestAdapter(
  finalUrl: string,
  adapters: AdapterManifest[],
): NearestAdapter | null {
  let host: string;
  try {
    host = new URL(finalUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
  const parts = host.split(".");
  const apex = parts.slice(-2).join(".");
  const siteKey = parts.length > 1 ? parts[parts.length - 2] : host;

  const hits = adapters
    .map((adapter) => {
      const domain = adapter.domain?.replace(/^www\./, "").toLowerCase();
      const matches =
        (domain != null && (host.endsWith(domain) || domain.endsWith(apex))) ||
        adapter.name.toLowerCase() === siteKey ||
        host.includes(adapter.name.toLowerCase());
      return matches ? adapter : null;
    })
    .filter((adapter): adapter is AdapterManifest => adapter != null);

  if (hits.length === 0) return null;
  hits.sort(
    (a, b) =>
      Object.keys(b.commands).length - Object.keys(a.commands).length ||
      a.name.localeCompare(b.name),
  );
  const best = hits[0];
  const examples = Object.keys(best.commands)
    .sort()
    .slice(0, 5)
    .map((name) => `${best.name} ${name}`);

  return {
    site: best.name,
    example_commands: examples,
    reason: `${Object.keys(best.commands).length} existing adapter(s) target this site`,
  };
}

export interface AnalyzeReport {
  requested_url: string;
  final_url: string;
  title: string;
  pattern: PatternVerdict;
  anti_bot: AntiBotVerdict;
  initial_state: PageSignals["initialState"];
  nearest_adapter: NearestAdapter | null;
  recommended_next_step: string;
}

export function analyzeSite(
  signals: PageSignals,
  adapters: AdapterManifest[],
): AnalyzeReport {
  const pattern = classifyPattern(signals);
  const antiBot = detectAntiBot(signals);
  const nearest = findNearestAdapter(signals.finalUrl, adapters);

  let next = "Inspect `unicli browser network --all` and choose a source.";
  if (antiBot.detected) next = antiBot.implication;
  else if (pattern.pattern === "A")
    next =
      "Run `unicli browser network --filter <field>` and validate the best JSON endpoint with cookies before generating an adapter.";
  else if (pattern.pattern === "B")
    next =
      "Read the SSR state global with `unicli browser eval` and map fields from that payload.";
  else if (pattern.pattern === "C")
    next =
      "Use rendered HTML extraction first; escalate to bundle/API discovery only if the page hides target data.";
  else if (pattern.pattern === "D")
    next =
      "Re-open from a signed-in browser session, inspect headers/tokens, and keep the adapter browser-backed until direct fetch proves reusable.";
  else if (pattern.pattern === "E")
    next =
      "Find the HTTP poll or initial snapshot behind the stream; raw WebSocket-only adapters are not reusable enough.";

  return {
    requested_url: signals.requestedUrl,
    final_url: signals.finalUrl,
    title: signals.title,
    pattern,
    anti_bot: antiBot,
    initial_state: signals.initialState,
    nearest_adapter: nearest,
    recommended_next_step: next,
  };
}
