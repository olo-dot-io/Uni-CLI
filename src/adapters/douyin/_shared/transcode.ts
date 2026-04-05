/**
 * Transcode poller for Douyin video processing.
 *
 * Polls the transcode status endpoint until encode=2 (complete)
 * or a timeout is reached.
 */

import type { IPage } from "../../../types.js";
import { browserFetch } from "./browser-fetch.js";
import type { TranscodeResult } from "./types.js";

const POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const TRANSCODE_URL_BASE =
  "https://creator.douyin.com/web/api/media/video/transend/";

export async function pollTranscode(
  page: IPage,
  videoId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TranscodeResult> {
  const url = `${TRANSCODE_URL_BASE}?video_id=${encodeURIComponent(videoId)}&aid=1128`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = (await browserFetch(page, "GET", url)) as {
      encode: number;
    } & TranscodeResult;

    if (result.encode === 2) {
      return result;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
    );
  }

  throw new Error(
    `Douyin transcode for video ${videoId} timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}
