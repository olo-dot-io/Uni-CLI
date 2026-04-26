import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cli, Strategy } from "../../registry.js";
import { str } from "../_shared/browser-tools.js";

interface XiaoyuzhouCredentials {
  access_token?: string;
  device_id?: string;
}

interface XiaoyuzhouEpisode {
  title?: string;
  media?: {
    source?: {
      url?: string;
    };
  };
  enclosure?: {
    url?: string;
  };
  audio?: {
    url?: string;
  };
}

async function readCredentials(): Promise<XiaoyuzhouCredentials> {
  if (process.env.XIAOYUZHOU_ACCESS_TOKEN) {
    return {
      access_token: process.env.XIAOYUZHOU_ACCESS_TOKEN,
      device_id: process.env.XIAOYUZHOU_DEVICE_ID,
    };
  }
  try {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(
      join(homedir(), ".unicli", "xiaoyuzhou.json"),
      "utf8",
    );
    return JSON.parse(text) as XiaoyuzhouCredentials;
  } catch {
    return {};
  }
}

async function apiPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const credentials = await readCredentials();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (compatible; Uni-CLI)",
  };
  if (credentials.access_token) {
    headers.authorization = `Bearer ${credentials.access_token}`;
  }
  if (credentials.device_id) {
    headers["x-jike-device-id"] = credentials.device_id;
  }
  const response = await fetch(`https://api.xiaoyuzhoufm.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`xiaoyuzhou request failed: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function episode(eid: string): Promise<XiaoyuzhouEpisode> {
  const data = await apiPost<{ data?: XiaoyuzhouEpisode }>("/v1/episode/get", {
    eid,
  });
  return data.data ?? {};
}

function audioUrl(item: XiaoyuzhouEpisode): string {
  return (
    item.media?.source?.url ?? item.enclosure?.url ?? item.audio?.url ?? ""
  );
}

cli({
  site: "xiaoyuzhou",
  name: "download",
  description: "Download Xiaoyuzhou episode audio",
  domain: "xiaoyuzhou.fm",
  strategy: Strategy.COOKIE,
  args: [
    { name: "eid", type: "str", required: true, positional: true },
    { name: "output", type: "str", default: "./xiaoyuzhou" },
  ],
  columns: ["title", "path", "bytes"],
  func: async (_page, kwargs) => {
    const eid = str(kwargs.eid);
    const item = await episode(eid);
    const url = audioUrl(item);
    if (!url) throw new Error("Episode audio URL not found");
    const output = str(kwargs.output, "./xiaoyuzhou");
    await mkdir(output, { recursive: true });
    const response = await fetch(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    const name = basename(new URL(url).pathname) || `${eid}.mp3`;
    const path = join(output, name);
    await writeFile(path, bytes);
    return [{ title: item.title ?? "", path, bytes: bytes.length }];
  },
});

cli({
  site: "xiaoyuzhou",
  name: "transcript",
  description: "Download Xiaoyuzhou transcript JSON and extracted text",
  domain: "xiaoyuzhou.fm",
  strategy: Strategy.COOKIE,
  args: [
    { name: "eid", type: "str", required: true, positional: true },
    { name: "output", type: "str", default: "./xiaoyuzhou-transcripts" },
  ],
  columns: ["eid", "path", "text"],
  func: async (_page, kwargs) => {
    const eid = str(kwargs.eid);
    const output = str(kwargs.output, "./xiaoyuzhou-transcripts");
    const data = await apiPost<Record<string, unknown>>(
      "/v1/episode/transcript",
      { eid },
    );
    await mkdir(output, { recursive: true });
    const path = join(output, `${eid}.json`);
    await writeFile(path, JSON.stringify(data, null, 2));
    const text = JSON.stringify(data)
      .replace(/[{}"\\[\\],:]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return [{ eid, path, text: text.slice(0, 8000) }];
  },
});
