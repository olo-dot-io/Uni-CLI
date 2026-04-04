/**
 * WBI signing utility for Bilibili API requests.
 *
 * Bilibili's WBI mechanism signs query parameters with a rotating key
 * derived from the nav API. Keys are cached for 10 minutes.
 */

import { createHash } from "node:crypto";
import { loadCookies, formatCookieHeader } from "../../engine/cookies.js";
import { USER_AGENT } from "../../constants.js";

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

let cachedMixinKey: string | null = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000;

function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i])
    .join("")
    .slice(0, 32);
}

async function fetchWbiKeys(): Promise<string> {
  const now = Date.now();
  if (cachedMixinKey && now - cachedAt < CACHE_TTL) return cachedMixinKey;

  const cookies = loadCookies("bilibili");
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (cookies) headers["Cookie"] = formatCookieHeader(cookies);

  const resp = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers,
  });
  const json = (await resp.json()) as {
    data: { wbi_img: { img_url: string; sub_url: string } };
  };

  const imgKey = json.data.wbi_img.img_url.split("/").pop()!.split(".")[0];
  const subKey = json.data.wbi_img.sub_url.split("/").pop()!.split(".")[0];

  cachedMixinKey = getMixinKey(imgKey, subKey);
  cachedAt = now;
  return cachedMixinKey;
}

/** Sign query parameters with WBI and return the full query string. */
export async function signWbi(params: Record<string, string>): Promise<string> {
  const mixinKey = await fetchWbiKeys();
  const wts = Math.floor(Date.now() / 1000);
  params.wts = String(wts);

  const sorted = Object.keys(params).sort();
  const query = sorted
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");

  const wRid = createHash("md5")
    .update(query + mixinKey)
    .digest("hex");

  return query + "&w_rid=" + wRid;
}

/** Fetch a Bilibili API endpoint with WBI-signed parameters. */
export async function wbiFetch(
  baseUrl: string,
  params: Record<string, string>,
): Promise<unknown> {
  const query = await signWbi(params);
  const url = `${baseUrl}?${query}`;

  const cookies = loadCookies("bilibili");
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Referer: "https://www.bilibili.com",
  };
  if (cookies) headers["Cookie"] = formatCookieHeader(cookies);

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`Bilibili API error: ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}
