export interface ExtensionNetworkCaptureEntry {
  url: string;
  method: string;
  status: number;
  contentType: string;
  size: number;
  timestamp: number;
  responseBody?: string;
}

type CaptureMatcher = (url: string) => boolean;

interface CaptureState {
  matcher: CaptureMatcher;
  entries: ExtensionNetworkCaptureEntry[];
  requestMethods: Map<string, string>;
  requestToIndex: Map<string, number>;
}

interface NetworkRequestWillBeSentParams {
  requestId?: string;
  request?: {
    method?: string;
  };
}

interface NetworkResponseReceivedParams {
  requestId?: string;
  response?: {
    url?: string;
    status?: number;
    mimeType?: string;
    headers?: Record<string, unknown>;
  };
  timestamp?: number;
}

interface NetworkLoadingFinishedParams {
  requestId?: string;
  encodedDataLength?: number;
}

interface NetworkGetResponseBodyResult {
  body?: string;
  base64Encoded?: boolean;
}

const captureStates = new Map<number, CaptureState>();
const attachedTabs = new Set<number>();
let listenersRegistered = false;

function parseMatcher(pattern?: string): CaptureMatcher {
  if (!pattern) return (url) => /^https?:/i.test(url);

  const regexMatch = /^\/(.+)\/([a-z]*)$/i.exec(pattern);
  if (!regexMatch) {
    return (url) => /^https?:/i.test(url) && url.includes(pattern);
  }

  try {
    const flags = regexMatch[2].replace(/g/g, "");
    const regex = new RegExp(regexMatch[1], flags);
    return (url) => /^https?:/i.test(url) && regex.test(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid network capture regex: ${message}`);
  }
}

function contentTypeFrom(response?: NetworkResponseReceivedParams["response"]) {
  if (response?.mimeType) return response.mimeType;
  const headers = response?.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") return String(value);
  }
  return "unknown";
}

function contentLengthFrom(
  response?: NetworkResponseReceivedParams["response"],
) {
  const headers = response?.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "content-length") continue;
    const size = Number.parseInt(String(value), 10);
    return Number.isFinite(size) ? size : 0;
  }
  return 0;
}

async function ensureAttached(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already attached/i.test(message)) throw err;
    }
    attachedTabs.add(tabId);
  }
}

function compactRequestIndexes(state: CaptureState): void {
  const next = new Map<string, number>();
  for (const [requestId, index] of state.requestToIndex) {
    if (index === 0) {
      state.requestMethods.delete(requestId);
      continue;
    }
    next.set(requestId, index - 1);
  }
  state.requestToIndex = next;
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

export async function startNetworkCapture(
  tabId: number,
  pattern?: string,
): Promise<void> {
  registerNetworkCaptureListeners();
  const matcher = parseMatcher(pattern);
  await ensureAttached(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  } catch (err) {
    attachedTabs.delete(tabId);
    throw err;
  }
  captureStates.set(tabId, {
    matcher,
    entries: [],
    requestMethods: new Map(),
    requestToIndex: new Map(),
  });
}

export function readNetworkCapture(
  tabId: number,
): ExtensionNetworkCaptureEntry[] {
  const state = captureStates.get(tabId);
  if (!state) return [];
  const entries = state.entries.slice();
  state.entries = [];
  state.requestToIndex.clear();
  state.requestMethods.clear();
  return entries;
}

function handleRequestWillBeSent(
  tabId: number,
  params: NetworkRequestWillBeSentParams,
): void {
  const state = captureStates.get(tabId);
  if (!state || !params.requestId) return;
  state.requestMethods.set(params.requestId, params.request?.method ?? "GET");
}

function handleResponseReceived(
  tabId: number,
  params: NetworkResponseReceivedParams,
): void {
  const state = captureStates.get(tabId);
  if (!state || !params.requestId) return;
  const url = params.response?.url ?? "";
  if (!state.matcher(url)) return;

  const entry: ExtensionNetworkCaptureEntry = {
    url,
    method: state.requestMethods.get(params.requestId) ?? "GET",
    status: params.response?.status ?? 0,
    contentType: contentTypeFrom(params.response),
    size: contentLengthFrom(params.response),
    timestamp: params.timestamp ?? Date.now(),
  };
  state.entries.push(entry);
  state.requestToIndex.set(params.requestId, state.entries.length - 1);

  if (state.entries.length > 100) {
    state.entries.shift();
    compactRequestIndexes(state);
  }
}

async function handleLoadingFinished(
  tabId: number,
  params: NetworkLoadingFinishedParams,
): Promise<void> {
  const state = captureStates.get(tabId);
  if (!state || !params.requestId) return;
  const index = state.requestToIndex.get(params.requestId);
  if (index === undefined) return;
  const entry = state.entries[index];
  if (!entry) return;

  if (params.encodedDataLength && params.encodedDataLength > 0) {
    entry.size = params.encodedDataLength;
  }

  try {
    const body = (await chrome.debugger.sendCommand(
      { tabId },
      "Network.getResponseBody",
      { requestId: params.requestId },
    )) as NetworkGetResponseBodyResult;
    if (typeof body.body === "string") {
      entry.responseBody = body.base64Encoded
        ? decodeBase64Utf8(body.body)
        : body.body;
    }
  } catch {
    // Body retrieval is best effort; redirects and streams may not expose one.
  } finally {
    state.requestMethods.delete(params.requestId);
  }
}

function clearTab(tabId?: number): void {
  if (tabId === undefined) return;
  attachedTabs.delete(tabId);
  captureStates.delete(tabId);
}

export function registerNetworkCaptureListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    if (method === "Network.requestWillBeSent") {
      handleRequestWillBeSent(tabId, params as NetworkRequestWillBeSentParams);
      return;
    }
    if (method === "Network.responseReceived") {
      handleResponseReceived(tabId, params as NetworkResponseReceivedParams);
      return;
    }
    if (method === "Network.loadingFinished") {
      void handleLoadingFinished(tabId, params as NetworkLoadingFinishedParams);
    }
  });

  chrome.debugger.onDetach.addListener((source) => clearTab(source.tabId));
  chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));
}
