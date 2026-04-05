/**
 * TOS (ByteDance Object Storage) multipart uploader with resume support.
 *
 * Uses AWS Signature V4 (HMAC-SHA256) with STS2 temporary credentials.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Sts2Credentials, TosUploadInfo } from "./types.js";

export interface TosUploadOptions {
  filePath: string;
  uploadInfo: TosUploadInfo;
  credentials: Sts2Credentials;
  onProgress?: (uploaded: number, total: number) => void;
}

interface ResumePart {
  partNumber: number;
  etag: string;
}

interface ResumeState {
  uploadId: string;
  fileSize: number;
  parts: ResumePart[];
}

const PART_SIZE = 5 * 1024 * 1024; // 5 MB
const RESUME_DIR = path.join(os.homedir(), ".unicli", "douyin-resume");

function getResumeFilePath(filePath: string): string {
  const hash = crypto.createHash("sha256").update(filePath).digest("hex");
  return path.join(RESUME_DIR, `${hash}.json`);
}

function loadResumeState(
  resumePath: string,
  fileSize: number,
): ResumeState | null {
  try {
    const raw = fs.readFileSync(resumePath, "utf8");
    const state = JSON.parse(raw) as ResumeState;
    if (
      state.fileSize === fileSize &&
      state.uploadId &&
      Array.isArray(state.parts)
    ) {
      return state;
    }
  } catch {
    // no valid resume state
  }
  return null;
}

function saveResumeState(resumePath: string, state: ResumeState): void {
  fs.mkdirSync(path.dirname(resumePath), { recursive: true });
  fs.writeFileSync(resumePath, JSON.stringify(state, null, 2), "utf8");
}

function deleteResumeState(resumePath: string): void {
  try {
    fs.unlinkSync(resumePath);
  } catch {
    // ignore
  }
}

// AWS Signature V4 helpers

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Buffer | string): string {
  const hash = crypto.createHash("sha256");
  if (typeof data === "string") {
    hash.update(data, "utf8");
  } else {
    hash.update(data);
  }
  return hash.digest("hex");
}

function extractRegionFromHost(host: string): string {
  const match = host.match(/^tos-([^.]+)\./);
  if (match) return match[1];
  return "cn-north-1";
}

function computeAws4Headers(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | string;
  credentials: Sts2Credentials;
  service: string;
  region: string;
  datetime: string;
}): Record<string, string> {
  const { method, url, credentials, service, region, datetime } = opts;
  const date = datetime.slice(0, 8);
  const parsedUrl = new URL(url);
  const canonicalUri = parsedUrl.pathname || "/";
  const queryParams = [...parsedUrl.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const bodyHash = sha256Hex(opts.body);

  const allHeaders: Record<string, string> = {
    ...opts.headers,
    host: parsedUrl.host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": datetime,
    "x-amz-security-token": credentials.session_token,
  };

  const sortedHeaderKeys = Object.keys(allHeaders).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );

  const canonicalHeaders =
    sortedHeaderKeys
      .map((k) => `${k.toLowerCase()}:${allHeaders[k].trim()}`)
      .join("\n") + "\n";
  const signedHeadersList = sortedHeaderKeys
    .map((k) => k.toLowerCase())
    .join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    queryParams,
    canonicalHeaders,
    signedHeadersList,
    bodyHash,
  ].join("\n");

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    datetime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${credentials.secret_access_key}`, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.access_key_id}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  return { ...allHeaders, Authorization: authorization };
}

async function tosRequest(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer | string;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const fetchBody: RequestInit["body"] =
    opts.body == null
      ? null
      : typeof opts.body === "string"
        ? opts.body
        : (opts.body as unknown as Uint8Array);
  const res = await fetch(opts.url, {
    method: opts.method,
    headers: opts.headers,
    body: fetchBody,
  });
  const responseBody = await res.text();
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });
  return { status: res.status, headers: responseHeaders, body: responseBody };
}

function nowDatetime(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

async function initMultipartUpload(
  tosUrl: string,
  auth: string,
  credentials: Sts2Credentials,
): Promise<string> {
  const initUrl = `${tosUrl}?uploads`;
  const datetime = nowDatetime();
  const headers: Record<string, string> = {
    Authorization: auth,
    "x-amz-date": datetime,
    "x-amz-security-token": credentials.session_token,
    "content-type": "application/octet-stream",
  };

  const res = await tosRequest({ method: "POST", url: initUrl, headers });
  if (res.status !== 200) {
    throw new Error(
      `TOS init multipart upload failed with status ${res.status}: ${res.body}`,
    );
  }

  const match = res.body.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!match) {
    throw new Error(`TOS init response missing UploadId: ${res.body}`);
  }
  return match[1];
}

async function uploadPart(
  tosUrl: string,
  partNumber: number,
  uploadId: string,
  data: Buffer,
  credentials: Sts2Credentials,
  region: string,
): Promise<string> {
  const parsedUrl = new URL(tosUrl);
  parsedUrl.searchParams.set("partNumber", String(partNumber));
  parsedUrl.searchParams.set("uploadId", uploadId);
  const url = parsedUrl.toString();

  const datetime = nowDatetime();
  const headers = computeAws4Headers({
    method: "PUT",
    url,
    headers: { "content-type": "application/octet-stream" },
    body: data,
    credentials,
    service: "tos",
    region,
    datetime,
  });

  const res = await tosRequest({ method: "PUT", url, headers, body: data });
  if (res.status !== 200) {
    throw new Error(
      `TOS upload part ${partNumber} failed with status ${res.status}: ${res.body}`,
    );
  }

  const etag = res.headers["etag"];
  if (!etag) {
    throw new Error(
      `TOS upload part ${partNumber} response missing ETag header`,
    );
  }
  return etag;
}

async function completeMultipartUpload(
  tosUrl: string,
  uploadId: string,
  parts: ResumePart[],
  credentials: Sts2Credentials,
  region: string,
): Promise<void> {
  const parsedUrl = new URL(tosUrl);
  parsedUrl.searchParams.set("uploadId", uploadId);
  const url = parsedUrl.toString();

  const xmlBody =
    "<CompleteMultipartUpload>" +
    parts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(
        (p) =>
          `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`,
      )
      .join("") +
    "</CompleteMultipartUpload>";

  const datetime = nowDatetime();
  const headers = computeAws4Headers({
    method: "POST",
    url,
    headers: { "content-type": "application/xml" },
    body: xmlBody,
    credentials,
    service: "tos",
    region,
    datetime,
  });

  const res = await tosRequest({
    method: "POST",
    url,
    headers,
    body: xmlBody,
  });
  if (res.status !== 200) {
    throw new Error(
      `TOS complete multipart upload failed with status ${res.status}: ${res.body}`,
    );
  }
}

export async function tosUpload(options: TosUploadOptions): Promise<void> {
  const { filePath, uploadInfo, credentials, onProgress } = options;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file not found: ${filePath}`);
  }

  const { size: fileSize } = fs.statSync(filePath);
  if (fileSize === 0) {
    throw new Error(`Video file is empty: ${filePath}`);
  }

  const { tos_upload_url: tosUrl, auth } = uploadInfo;
  const parsedTosUrl = new URL(tosUrl);
  const region = extractRegionFromHost(parsedTosUrl.host);

  const resumePath = getResumeFilePath(filePath);
  const resumeState = loadResumeState(resumePath, fileSize);

  let uploadId: string;
  let completedParts: ResumePart[];

  if (resumeState) {
    uploadId = resumeState.uploadId;
    completedParts = resumeState.parts;
  } else {
    uploadId = await initMultipartUpload(tosUrl, auth, credentials);
    completedParts = [];
    saveResumeState(resumePath, { uploadId, fileSize, parts: completedParts });
  }

  const completedPartNumbers = new Set(completedParts.map((p) => p.partNumber));
  const totalParts = Math.ceil(fileSize / PART_SIZE);
  let uploadedBytes = completedParts.length * PART_SIZE;
  if (onProgress) onProgress(Math.min(uploadedBytes, fileSize), fileSize);

  const fd = fs.openSync(filePath, "r");
  try {
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      if (completedPartNumbers.has(partNumber)) continue;

      const offset = (partNumber - 1) * PART_SIZE;
      const chunkSize = Math.min(PART_SIZE, fileSize - offset);
      const buffer = Buffer.allocUnsafe(chunkSize);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, offset);
      if (bytesRead !== chunkSize) {
        throw new Error(
          `Short read on part ${partNumber}: expected ${chunkSize} bytes, got ${bytesRead}`,
        );
      }

      const etag = await uploadPart(
        tosUrl,
        partNumber,
        uploadId,
        buffer,
        credentials,
        region,
      );

      completedParts.push({ partNumber, etag });
      saveResumeState(resumePath, {
        uploadId,
        fileSize,
        parts: completedParts,
      });

      uploadedBytes = Math.min(offset + chunkSize, fileSize);
      if (onProgress) onProgress(uploadedBytes, fileSize);
    }
  } finally {
    fs.closeSync(fd);
  }

  await completeMultipartUpload(
    tosUrl,
    uploadId,
    completedParts,
    credentials,
    region,
  );
  deleteResumeState(resumePath);
}
