/**
 * @owner   src/engine/objective/media-playback.ts
 * @does    Defines the media playback objective workflow and provider strategies.
 * @needs   src/engine/objective/types.ts
 * @feeds   src/engine/objective/planner.ts
 * @breaks  Broad keyword matching can misclassify travel or browser intents as music playback.
 * @invariants Provider gaps are explicit; partial desktop paths never claim end-to-end playback.
 * @side-effects none.
 * @perf    O(intent length + provider count).
 * @concurrency pure and reentrant.
 * @test    tests/unit/objective-compiler.test.ts, tests/unit/commands/do.test.ts
 * @stability experimental
 * @since   2026-06-01
 */

import type {
  ObjectiveStrategy,
  ObjectiveWorkflow,
  ObjectiveWorkflowDraft,
} from "./types.js";

type MediaProvider = "spotify" | "netease-music" | "apple-music";

const MEDIA_TRIGGERS = [
  /我想听/u,
  /想听/u,
  /听一下/u,
  /播放/u,
  /放一下/u,
  /\blisten\s+to\b/i,
  /\bplay\b/i,
] as const;

const PROVIDER_HINTS: readonly {
  provider: MediaProvider;
  pattern: RegExp;
}[] = [
  { provider: "spotify", pattern: /\bspotify\b/i },
  {
    provider: "netease-music",
    pattern: /网易云|网易云音乐|\bnetease(?:\s+cloud)?(?:\s+music)?\b/i,
  },
  {
    provider: "apple-music",
    pattern: /apple\s+music|苹果音乐|\bMusic\.app\b/i,
  },
];

export const mediaPlaybackWorkflow: ObjectiveWorkflow = {
  id: "media.playback",
  compile(intent: string): ObjectiveWorkflowDraft | undefined {
    const normalizedIntent = normalizeIntent(intent);
    const query = extractMediaPlaybackQuery(normalizedIntent);
    if (!query) return undefined;

    const providers = prioritizeProviders(normalizedIntent);
    const strategies = providers.map((provider, index) =>
      mediaPlaybackStrategy(provider, query, index),
    );
    return {
      objective: {
        id: "media-playback",
        kind: "media.playback",
        goal: intent.trim(),
        confidence: 0.92,
        slots: {
          query,
          preferred_providers: providers,
        },
        evidence_gates: [
          { kind: "run_completed" },
          { kind: "required_evidence_type", evidence_type: "result-envelope" },
        ],
      },
      strategies,
      capability_gaps: providerCapabilityGaps(strategies),
    };
  },
};

function normalizeIntent(intent: string): string {
  return intent.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function extractMediaPlaybackQuery(intent: string): string | undefined {
  if (!MEDIA_TRIGGERS.some((trigger) => trigger.test(intent))) {
    return undefined;
  }

  let query = intent
    .replace(/^\s*(请|帮我|麻烦)?\s*(我想听|想听|听一下|播放|放一下)\s*/u, "")
    .replace(/^\s*(please\s+)?(listen\s+to|play)\s+/i, "")
    .replace(
      /\s+(on|in)\s+(spotify|apple\s+music|netease(?:\s+cloud)?(?:\s+music)?)\s*$/i,
      "",
    )
    .replace(
      /\s*(用|在)\s*(网易云音乐?|Spotify|spotify|Apple Music|苹果音乐)\s*$/u,
      "",
    )
    .trim();

  query = stripPairedQuotes(query);
  if (!query) return undefined;
  if (MEDIA_TRIGGERS.some((trigger) => trigger.test(query))) {
    return undefined;
  }
  return query;
}

function stripPairedQuotes(value: string): string {
  return value
    .replace(/^[`"'“”‘’]+/, "")
    .replace(/[`"'“”‘’]+$/, "")
    .trim();
}

function prioritizeProviders(intent: string): MediaProvider[] {
  const all: MediaProvider[] = ["spotify", "netease-music", "apple-music"];
  const hinted = PROVIDER_HINTS.find((hint) => hint.pattern.test(intent));
  if (!hinted) return all;
  return [
    hinted.provider,
    ...all.filter((provider) => provider !== hinted.provider),
  ];
}

function mediaPlaybackStrategy(
  provider: MediaProvider,
  query: string,
  index: number,
): ObjectiveStrategy {
  if (provider === "spotify") {
    return {
      id: "spotify-api-play-track",
      label: "Resolve and start Spotify playback through the native Web API",
      provider,
      substrate: "native-api",
      status: "executable",
      priority: 10 + index,
      steps: [
        {
          command: "spotify.play-track",
          args: { query },
          purpose: "Search Spotify for the requested track and start playback",
        },
      ],
      verification: {
        command: "spotify.status",
        purpose: "Verify the current Spotify track after playback starts",
      },
    };
  }

  if (provider === "netease-music") {
    return {
      id: "netease-desktop-search-play",
      label: "Use NetEase catalog search and desktop app control",
      provider,
      substrate: "desktop-cdp",
      status: "partial",
      priority: 10 + index,
      steps: [
        {
          command: "netease-music.search",
          args: { query, limit: 5 },
          purpose: "Resolve candidate songs before controlling the desktop app",
        },
        {
          command: "netease-music.open-app",
          purpose: "Open the controllable Electron desktop app",
        },
      ],
      verification: {
        command: "netease-music.status-app",
        purpose: "Inspect visible playback state in the desktop app",
      },
    };
  }

  return {
    id: "apple-music-native-search-play",
    label: "Use Apple Music native automation once search-and-play exists",
    provider,
    substrate: "desktop-ax",
    status: "missing",
    priority: 10 + index,
    steps: [
      {
        command: "macos.music-control",
        args: { action: "play" },
        purpose: "Control existing Apple Music playback",
      },
    ],
    verification: {
      command: "macos.music-now",
      purpose: "Verify current Apple Music playback state",
    },
  };
}

function providerCapabilityGaps(
  strategies: readonly ObjectiveStrategy[],
): ObjectiveWorkflowDraft["capability_gaps"] {
  const gaps: ObjectiveWorkflowDraft["capability_gaps"] = [];
  if (strategies.some((strategy) => strategy.provider === "netease-music")) {
    gaps.push({
      provider: "netease-music",
      missing: "netease-music.play-track",
      reason:
        "NetEase has search and desktop controls, but no single verified search-result-to-playback operation.",
    });
  }
  if (strategies.some((strategy) => strategy.provider === "apple-music")) {
    gaps.push({
      provider: "apple-music",
      missing: "apple-music.play-track",
      reason:
        "Apple Music has playback control and now-playing inspection, but no first-class query search and playback operation.",
    });
  }
  return gaps;
}
