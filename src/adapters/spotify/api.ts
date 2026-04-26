import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cli, Strategy } from "../../registry.js";
import { intArg, str } from "../_shared/browser-tools.js";

interface SpotifyTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

interface SpotifyConfig {
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_REDIRECT_URI?: string;
}

const TOKEN_PATH = join(homedir(), ".unicli", "spotify-tokens.json");
const ENV_PATH = join(homedir(), ".unicli", "spotify.env");

async function readConfig(): Promise<SpotifyConfig> {
  const config: SpotifyConfig = {
    SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET,
    SPOTIFY_REDIRECT_URI: process.env.SPOTIFY_REDIRECT_URI,
  };
  try {
    const text = await readFile(ENV_PATH, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) config[match[1] as keyof SpotifyConfig] = match[2];
    }
  } catch {
    // Environment variables are enough for non-interactive use.
  }
  return config;
}

async function readTokens(): Promise<SpotifyTokens> {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8")) as SpotifyTokens;
  } catch {
    return {};
  }
}

async function writeTokens(tokens: SpotifyTokens): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken(): Promise<string> {
  const config = await readConfig();
  const tokens = await readTokens();
  if (tokens.access_token && (tokens.expires_at ?? 0) > Date.now() + 60_000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) {
    throw new Error("Spotify refresh token missing. Run spotify auth first.");
  }
  if (!config.SPOTIFY_CLIENT_ID || !config.SPOTIFY_CLIENT_SECRET) {
    throw new Error(`Spotify app config missing in ${ENV_PATH}`);
  }
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(
        `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`,
      ).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!response.ok) {
    throw new Error(`Spotify token refresh failed: HTTP ${response.status}`);
  }
  const data = (await response.json()) as SpotifyTokens & {
    expires_in?: number;
  };
  const next = {
    ...tokens,
    ...data,
    expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
  await writeTokens(next);
  return str(next.access_token);
}

async function spotifyApi(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const token = await refreshAccessToken();
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (response.status === 204) return { ok: true };
  if (!response.ok) {
    const preview = await response.text().catch(() => "");
    throw new Error(
      `Spotify API failed: HTTP ${response.status} ${preview.slice(0, 160)}`,
    );
  }
  return response.json();
}

async function searchTrack(query: string): Promise<string> {
  const data = (await spotifyApi(
    `/search?type=track&limit=1&q=${encodeURIComponent(query)}`,
  )) as { tracks?: { items?: Array<{ uri?: string }> } };
  const uri = data.tracks?.items?.[0]?.uri;
  if (!uri) throw new Error(`No Spotify track found for query: ${query}`);
  return uri;
}

cli({
  site: "spotify",
  name: "auth",
  description: "Create or complete Spotify OAuth setup",
  domain: "api.spotify.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "code", type: "str", required: false }],
  columns: ["status", "url"],
  func: async (_page, kwargs) => {
    const config = await readConfig();
    const redirect =
      config.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:8888/callback";
    if (!config.SPOTIFY_CLIENT_ID) {
      throw new Error(`Spotify client id missing in ${ENV_PATH}`);
    }
    if (!kwargs.code) {
      const scopes = [
        "user-read-playback-state",
        "user-modify-playback-state",
        "user-read-currently-playing",
        "streaming",
      ].join(" ");
      const url = new URL("https://accounts.spotify.com/authorize");
      url.searchParams.set("client_id", config.SPOTIFY_CLIENT_ID);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", redirect);
      url.searchParams.set("scope", scopes);
      return [{ status: "open_authorize_url", url: url.href }];
    }
    if (!config.SPOTIFY_CLIENT_SECRET) {
      throw new Error(`Spotify client secret missing in ${ENV_PATH}`);
    }
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(
          `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`,
        ).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: str(kwargs.code),
        redirect_uri: redirect,
      }),
    });
    if (!response.ok) {
      throw new Error(`Spotify auth failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as SpotifyTokens & {
      expires_in?: number;
    };
    await writeTokens({
      ...data,
      expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    });
    return [{ status: "saved", url: TOKEN_PATH }];
  },
});

cli({
  site: "spotify",
  name: "status",
  description: "Show current Spotify playback status",
  domain: "api.spotify.com",
  strategy: Strategy.COOKIE,
  columns: ["track", "artist", "is_playing", "progress_ms"],
  func: async () => {
    const data = (await spotifyApi("/me/player")) as {
      is_playing?: boolean;
      progress_ms?: number;
      item?: { name?: string; artists?: Array<{ name?: string }> };
      device?: { name?: string; volume_percent?: number };
    };
    return [
      {
        track: data.item?.name ?? "",
        artist: data.item?.artists?.map((a) => a.name).join(", ") ?? "",
        is_playing: data.is_playing ?? false,
        progress_ms: data.progress_ms ?? 0,
        device: data.device?.name ?? "",
        volume: data.device?.volume_percent ?? "",
      },
    ];
  },
});

cli({
  site: "spotify",
  name: "volume",
  description: "Set Spotify playback volume",
  domain: "api.spotify.com",
  strategy: Strategy.COOKIE,
  args: [{ name: "percent", type: "int", required: true, positional: true }],
  columns: ["ok", "volume"],
  func: async (_page, kwargs) => {
    const volume = intArg(kwargs.percent, 50, 100);
    await spotifyApi(`/me/player/volume?volume_percent=${volume}`, {
      method: "PUT",
    });
    return [{ ok: true, volume }];
  },
});

cli({
  site: "spotify",
  name: "queue",
  description: "Add a Spotify track to the playback queue",
  domain: "api.spotify.com",
  strategy: Strategy.COOKIE,
  args: [{ name: "query", type: "str", required: true, positional: true }],
  columns: ["ok", "uri"],
  func: async (_page, kwargs) => {
    const uri = await searchTrack(str(kwargs.query));
    await spotifyApi(`/me/player/queue?uri=${encodeURIComponent(uri)}`, {
      method: "POST",
    });
    return [{ ok: true, uri }];
  },
});

cli({
  site: "spotify",
  name: "shuffle",
  description: "Toggle Spotify shuffle mode",
  domain: "api.spotify.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "state",
      type: "str",
      required: true,
      positional: true,
      choices: ["on", "off"],
    },
  ],
  columns: ["ok", "state"],
  func: async (_page, kwargs) => {
    const state = str(kwargs.state).toLowerCase() === "on";
    await spotifyApi(`/me/player/shuffle?state=${state}`, { method: "PUT" });
    return [{ ok: true, state }];
  },
});

cli({
  site: "spotify",
  name: "repeat",
  description: "Set Spotify repeat mode",
  domain: "api.spotify.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "state",
      type: "str",
      required: true,
      positional: true,
      choices: ["off", "track", "context"],
    },
  ],
  columns: ["ok", "state"],
  func: async (_page, kwargs) => {
    const state = str(kwargs.state, "off");
    await spotifyApi(`/me/player/repeat?state=${encodeURIComponent(state)}`, {
      method: "PUT",
    });
    return [{ ok: true, state }];
  },
});
