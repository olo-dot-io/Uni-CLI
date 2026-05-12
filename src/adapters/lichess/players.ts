/**
 * @owner   src/adapters/lichess/players.ts
 * @does    Register agent-facing Lichess public user and leaderboard commands.
 * @needs   lichess.org public JSON API, perf whitelist, bounded result limits.
 * @feeds   surface coverage ledger, chess player lookup, leaderboard inspection.
 * @breaks  Lichess API drift, weak handle validation, or silent disabled-account rows hide player state.
 */

import { cli, Strategy } from "../../registry.js";

const LICHESS_BASE = "https://lichess.org";
const PERFS = new Set([
  "ultraBullet",
  "bullet",
  "blitz",
  "rapid",
  "classical",
  "chess960",
  "crazyhouse",
  "antichess",
  "atomic",
  "horde",
  "kingOfTheHill",
  "racingKings",
  "threeCheck",
]);

interface LichessPerf {
  rating?: unknown;
  progress?: unknown;
  games?: unknown;
}

interface LichessUser {
  username?: unknown;
  id?: unknown;
  title?: unknown;
  patron?: unknown;
  online?: unknown;
  tosViolation?: unknown;
  disabled?: unknown;
  createdAt?: unknown;
  seenAt?: unknown;
  count?: { all?: unknown; win?: unknown; loss?: unknown; draw?: unknown };
  perfs?: Record<string, LichessPerf>;
  profile?: { fideRating?: unknown; country?: unknown; bio?: unknown };
}

interface LichessTopBody {
  users?: LichessUser[];
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolField(value: unknown): boolean {
  return value === true;
}

export function requireLichessUsername(value: unknown): string {
  const username = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(username)) {
    throw new Error(
      "lichess username must be 2-30 letters, digits, underscores, or dashes.",
    );
  }
  return username;
}

export function requireLichessPerf(value: unknown): string {
  const perf = String(value ?? "").trim();
  if (!PERFS.has(perf)) {
    throw new Error(
      `lichess perf must be one of: ${Array.from(PERFS).join(", ")}.`,
    );
  }
  return perf;
}

export function requireLichessLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error("limit must be an integer in [1, 200].");
  }
  return n;
}

export function formatLichessTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mapLichessTopRows(
  body: LichessTopBody,
  perf: string,
  limit: number,
): Array<Record<string, unknown>> {
  const users = Array.isArray(body.users) ? body.users : [];
  if (users.length === 0) {
    throw new Error(`Lichess returned no leaderboard rows for perf "${perf}".`);
  }
  return users.slice(0, limit).map((user, index) => {
    const username = stringField(user.username);
    const perfBlock = user.perfs?.[perf] ?? {};
    return {
      rank: index + 1,
      username,
      id: stringField(user.id) || null,
      title: stringField(user.title) || null,
      rating: numberField(perfBlock.rating),
      progress: numberField(perfBlock.progress),
      patron: boolField(user.patron),
      url: username
        ? `${LICHESS_BASE}/@/${encodeURIComponent(username)}/perf/${encodeURIComponent(perf)}`
        : "",
    };
  });
}

export function mapLichessUserRow(
  body: LichessUser,
  requested: string,
): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    throw new Error(`Lichess user "${requested}" returned empty payload.`);
  }
  if (body.disabled === true) {
    throw new Error(`Lichess user "${requested}" is closed or disabled.`);
  }
  const perfs = body.perfs ?? {};
  const playable = Object.entries(perfs).filter(
    ([name, perf]) =>
      perf &&
      typeof perf === "object" &&
      !["puzzle", "storm", "racer", "streak"].includes(name),
  );
  let topPerfName: string | null = null;
  let topPerfRating: number | null = null;
  let topPerfGames: number | null = null;
  for (const [name, perf] of playable) {
    const games = numberField(perf.games) ?? 0;
    if (topPerfGames === null || games > topPerfGames) {
      topPerfName = name;
      topPerfGames = games;
      topPerfRating = numberField(perf.rating);
    }
  }
  const username = stringField(body.username) || requested;
  return {
    username,
    id: stringField(body.id) || null,
    title: stringField(body.title) || null,
    patron: boolField(body.patron),
    online: boolField(body.online),
    tosViolation: boolField(body.tosViolation),
    createdAt: formatLichessTimestamp(body.createdAt),
    seenAt: formatLichessTimestamp(body.seenAt),
    gamesAll: numberField(body.count?.all),
    gamesWin: numberField(body.count?.win),
    gamesLoss: numberField(body.count?.loss),
    gamesDraw: numberField(body.count?.draw),
    topPerfName,
    topPerfRating,
    topPerfGames,
    fideRating: numberField(body.profile?.fideRating),
    country: stringField(body.profile?.country) || null,
    bio: stringField(body.profile?.bio) || null,
    url: `${LICHESS_BASE}/@/${encodeURIComponent(username)}`,
  };
}

async function fetchLichessJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "unicli-lichess/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "lichess",
  name: "top",
  description: "Top-N Lichess leaderboard for a perf type",
  domain: "lichess.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "perf",
      type: "str",
      required: true,
      positional: true,
      description: "Perf type",
    },
    { name: "limit", type: "int", default: 10, description: "Top-N rows" },
  ],
  columns: [
    "rank",
    "username",
    "id",
    "title",
    "rating",
    "progress",
    "patron",
    "url",
  ],
  func: async (_page, kwargs) => {
    const perf = requireLichessPerf(kwargs.perf);
    const limit = requireLichessLimit(kwargs.limit, 10);
    const body = (await fetchLichessJson(
      `${LICHESS_BASE}/api/player/top/${limit}/${encodeURIComponent(perf)}`,
      `lichess top ${perf}`,
    )) as LichessTopBody;
    return mapLichessTopRows(body, perf, limit);
  },
});

cli({
  site: "lichess",
  name: "user",
  description: "Fetch a public Lichess player profile by username",
  domain: "lichess.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "username",
      type: "str",
      required: true,
      positional: true,
      description: "Lichess username",
    },
  ],
  columns: [
    "username",
    "id",
    "title",
    "patron",
    "online",
    "tosViolation",
    "createdAt",
    "seenAt",
    "gamesAll",
    "gamesWin",
    "gamesLoss",
    "gamesDraw",
    "topPerfName",
    "topPerfRating",
    "topPerfGames",
    "fideRating",
    "country",
    "bio",
    "url",
  ],
  func: async (_page, kwargs) => {
    const username = requireLichessUsername(kwargs.username);
    const body = (await fetchLichessJson(
      `${LICHESS_BASE}/api/user/${encodeURIComponent(username)}`,
      `lichess user ${username}`,
    )) as LichessUser;
    return [mapLichessUserRow(body, username)];
  },
});
