/**
 * ImageX cover image uploader.
 *
 * Uploads a JPEG/PNG image to ByteDance ImageX via a pre-signed PUT URL.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ImageXUploadInfo {
  upload_url: string;
  store_uri: string;
}

function detectContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

export async function imagexUpload(
  imagePath: string,
  uploadInfo: ImageXUploadInfo,
): Promise<string> {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Cover image file not found: ${imagePath}`);
  }

  const imageBuffer = fs.readFileSync(imagePath);
  const contentType = detectContentType(imagePath);

  const res = await fetch(uploadInfo.upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(imageBuffer.byteLength),
    },
    body: imageBuffer as unknown as BodyInit,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ImageX upload failed with status ${res.status}: ${body}`);
  }

  return uploadInfo.store_uri;
}
