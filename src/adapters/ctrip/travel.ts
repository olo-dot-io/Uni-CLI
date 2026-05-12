/**
 * @owner   src/adapters/ctrip/travel.ts
 * @does    Register agent-facing Ctrip destination, hotel, and flight commands.
 * @needs   Public Ctrip suggest endpoint plus logged-in or challenge-cleared browser sessions for hotel and flight pages.
 * @feeds   surface coverage ledger, travel search workflows, and Ctrip active command discovery.
 * @breaks  Ctrip suggest response drift, SSR hotel-list changes, flight-card DOM drift, or captcha gating.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const SUGGEST_ENDPOINT =
  "https://m.ctrip.com/restapi/soa2/21881/json/gaHotelSearchEngine";
const SUGGEST_DEFAULT_LIMIT = 15;
const SUGGEST_MAX_LIMIT = 50;
const HOTEL_DEFAULT_LIMIT = 10;
const HOTEL_MAX_LIMIT = 30;
const FLIGHT_DEFAULT_LIMIT = 20;
const FLIGHT_MAX_LIMIT = 50;

export const CTRIP_SUGGEST_COLUMNS = [
  "rank",
  "id",
  "type",
  "displayType",
  "name",
  "eName",
  "cityId",
  "cityName",
  "provinceName",
  "countryName",
  "lat",
  "lon",
  "score",
  "url",
];

const HOTEL_COLUMNS = [
  "rank",
  "hotelId",
  "name",
  "enName",
  "star",
  "score",
  "scoreLabel",
  "reviewCount",
  "cityName",
  "district",
  "address",
  "lat",
  "lon",
  "price",
  "currency",
  "url",
];

const FLIGHT_COLUMNS = [
  "rank",
  "airline",
  "flightNo",
  "aircraft",
  "departureTime",
  "departureAirport",
  "arrivalTime",
  "arrivalAirport",
  "terminal",
  "price",
  "currency",
  "cabin",
  "url",
];

interface CtripSuggestItem {
  id?: unknown;
  type?: unknown;
  word?: unknown;
  cityId?: unknown;
  cityName?: unknown;
  provinceName?: unknown;
  countryName?: unknown;
  displayName?: unknown;
  displayType?: unknown;
  eName?: unknown;
  commentScore?: unknown;
  cStar?: unknown;
  gdLat?: unknown;
  gdLon?: unknown;
  gLat?: unknown;
  gLon?: unknown;
  lat?: unknown;
  lon?: unknown;
}

interface CtripHotelEntry {
  hotelInfo?: {
    summary?: { hotelId?: unknown };
    nameInfo?: { name?: unknown; enName?: unknown };
    hotelStar?: { star?: unknown };
    commentInfo?: {
      commentScore?: unknown;
      commentDescription?: unknown;
      commenterNumber?: unknown;
    };
    positionInfo?: {
      cityName?: unknown;
      positionDesc?: unknown;
      address?: unknown;
      mapCoordinate?: unknown;
    };
  };
  roomInfo?: Array<{ priceInfo?: { price?: unknown; currency?: unknown } }>;
}

interface CtripFlightRow {
  airline?: unknown;
  flightNo?: unknown;
  aircraft?: unknown;
  departureTime?: unknown;
  departureAirport?: unknown;
  arrivalTime?: unknown;
  arrivalAirport?: unknown;
  terminal?: unknown;
  price?: unknown;
  currency?: unknown;
  cabin?: unknown;
}

function stringValue(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value);
  return text || null;
}

function finiteNonZero(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue !== 0 ? numberValue : null;
}

export function parseCtripLimit(
  raw: unknown,
  fallback = SUGGEST_DEFAULT_LIMIT,
  maxValue = SUGGEST_MAX_LIMIT,
): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`--limit must be an integer between 1 and ${maxValue}.`);
  }
  if (parsed < 1 || parsed > maxValue) {
    throw new Error(
      `--limit must be between 1 and ${maxValue}, got ${parsed}.`,
    );
  }
  return parsed;
}

export function requireCtripQuery(value: unknown): string {
  const query = stringValue(value);
  if (!query) throw new Error("Search keyword cannot be empty.");
  return query;
}

export function parseCtripIsoDate(name: string, raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error(`--${name} is required (YYYY-MM-DD).`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`--${name} must be YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`--${name} has invalid month/day: ${value}.`);
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`--${name} is not a real calendar date: ${value}.`);
  }
  return value;
}

export function parseCtripIataCode(name: string, raw: unknown): string {
  const value = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (!value) throw new Error(`--${name} is required (3-letter IATA code).`);
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new Error(`--${name} must be a 3-letter IATA code.`);
  }
  return value;
}

export function parseCtripCityId(raw: unknown): number {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw new Error(
      "--city is required (numeric city ID from ctrip search or hotel-suggest).",
    );
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--city must be a positive integer city ID, got ${value}.`);
  }
  return parsed;
}

export function assertCtripCheckinBeforeCheckout(
  checkin: string,
  checkout: string,
): void {
  if (
    Date.parse(`${checkin}T00:00:00Z`) >= Date.parse(`${checkout}T00:00:00Z`)
  ) {
    throw new Error(
      `--checkin must be earlier than --checkout (got ${checkin} >= ${checkout}).`,
    );
  }
}

export function pickCtripCoords(item: CtripSuggestItem): {
  lat: number | null;
  lon: number | null;
} {
  const candidates: Array<[unknown, unknown]> = [
    [item.gdLat, item.gdLon],
    [item.gLat, item.gLon],
    [item.lat, item.lon],
  ];
  for (const [lat, lon] of candidates) {
    const numericLat = Number(lat);
    const numericLon = Number(lon);
    if (
      Number.isFinite(numericLat) &&
      Number.isFinite(numericLon) &&
      (numericLat !== 0 || numericLon !== 0)
    ) {
      return { lat: numericLat, lon: numericLon };
    }
  }
  return { lat: null, lon: null };
}

export function buildCtripSuggestUrl(item: CtripSuggestItem): string | null {
  const id = item.id ? String(item.id) : "";
  const cityId = item.cityId ? String(item.cityId) : "";
  const cityName = item.cityName ? String(item.cityName) : "";
  switch (item.type) {
    case "City":
      return cityId
        ? `https://you.ctrip.com/place/${encodeURIComponent(cityName)}${cityId}.html`
        : null;
    case "Markland":
      return id && cityId
        ? `https://you.ctrip.com/sight/${encodeURIComponent(cityName)}${cityId}/${id}.html`
        : null;
    case "Hotel":
      return id
        ? `https://hotels.ctrip.com/hotels/detail/?hotelid=${id}`
        : null;
    case "BusinessArea":
    case "Zone":
      return cityId && id
        ? `https://hotels.ctrip.com/hotels/list?city=${cityId}&zone=${id}`
        : null;
    case "RailwayStation":
      return id ? `https://trains.ctrip.com/trainstation/${id}.html` : null;
    default:
      return null;
  }
}

export function mapCtripSuggestRow(
  item: CtripSuggestItem,
  index: number,
): Record<string, unknown> {
  const { lat, lon } = pickCtripCoords(item);
  return {
    rank: index + 1,
    id: item.id ? String(item.id) : null,
    type: item.type ? String(item.type) : null,
    displayType: nullableString(item.displayType),
    name:
      nullableString(item.displayName) ??
      nullableString(item.word) ??
      nullableString(item.cityName),
    eName: nullableString(item.eName),
    cityId: finiteNonZero(item.cityId),
    cityName: nullableString(item.cityName),
    provinceName: nullableString(item.provinceName),
    countryName: nullableString(item.countryName),
    lat,
    lon,
    score: finiteNonZero(item.commentScore) ?? finiteNonZero(item.cStar),
    url: buildCtripSuggestUrl(item),
  };
}

export function pickCtripHotelMapCoords(mapCoordinate: unknown): {
  lat: number | null;
  lon: number | null;
} {
  if (!Array.isArray(mapCoordinate) || mapCoordinate.length === 0) {
    return { lat: null, lon: null };
  }
  const ranking = (entry: Record<string, unknown>) => {
    const type = Number(entry.coordinateType);
    if (type === 1) return 0;
    if (type === 2) return 1;
    if (type === 3) return 2;
    return 3;
  };
  const sorted = [...mapCoordinate].sort(
    (a, b) =>
      ranking(a as Record<string, unknown>) -
      ranking(b as Record<string, unknown>),
  );
  for (const entry of sorted) {
    const record = entry as Record<string, unknown>;
    const lat = Number(record.latitude);
    const lon = Number(record.longitude);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      (lat !== 0 || lon !== 0)
    ) {
      return { lat, lon };
    }
  }
  return { lat: null, lon: null };
}

export function mapCtripHotelRow(
  entry: CtripHotelEntry,
  index: number,
): Record<string, unknown> {
  const hotelInfo = entry?.hotelInfo ?? {};
  const rooms = Array.isArray(entry?.roomInfo) ? entry.roomInfo : [];
  const summary = hotelInfo.summary ?? {};
  const nameInfo = hotelInfo.nameInfo ?? {};
  const hotelStar = hotelInfo.hotelStar ?? {};
  const commentInfo = hotelInfo.commentInfo ?? {};
  const positionInfo = hotelInfo.positionInfo ?? {};
  const priceInfo = rooms[0]?.priceInfo ?? {};
  const hotelId = summary.hotelId ? String(summary.hotelId) : null;
  const { lat, lon } = pickCtripHotelMapCoords(positionInfo.mapCoordinate);
  const commenterDigits = commentInfo.commenterNumber
    ? String(commentInfo.commenterNumber).replace(/[^\d]/g, "")
    : "";
  const star = finiteNonZero(hotelStar.star);
  const score = finiteNonZero(commentInfo.commentScore);
  const price = finiteNonZero(priceInfo.price);
  return {
    rank: index + 1,
    hotelId,
    name: nullableString(nameInfo.name),
    enName: nullableString(nameInfo.enName),
    star,
    score,
    scoreLabel: nullableString(commentInfo.commentDescription),
    reviewCount: commenterDigits ? Number(commenterDigits) : null,
    cityName: nullableString(positionInfo.cityName),
    district: nullableString(positionInfo.positionDesc),
    address: nullableString(positionInfo.address),
    lat,
    lon,
    price,
    currency: nullableString(priceInfo.currency),
    url: hotelId
      ? `https://hotels.ctrip.com/hotels/detail/?hotelid=${hotelId}`
      : null,
  };
}

async function fetchCtripSuggest(
  query: string,
  searchType: "D" | "H",
): Promise<CtripSuggestItem[]> {
  let response: Response;
  try {
    response = await fetch(SUGGEST_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keyword: query,
        searchType,
        platform: "online",
        pageID: "102001",
        head: {
          Locale: "zh-CN",
          LocaleController: "zh_cn",
          Currency: "CNY",
          PageId: "102001",
          clientID: "unicli-ctrip",
          group: "ctrip",
          Frontend: { sessionID: 1, pvid: 1 },
          HotelExtension: { group: "CTRIP", WebpSupport: false },
        },
      }),
    });
  } catch (error) {
    throw new Error(
      `ctrip suggest fetch failed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!response.ok) {
    throw new Error(`ctrip suggest failed with status ${response.status}.`);
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `ctrip suggest returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (payload.Result === false) {
    throw new Error(
      `ctrip suggest API returned Result=false (ErrorCode=${String(payload.ErrorCode ?? "unknown")}).`,
    );
  }
  const responsePayload = payload.Response as
    | { searchResults?: unknown }
    | undefined;
  return Array.isArray(responsePayload?.searchResults)
    ? (responsePayload.searchResults as CtripSuggestItem[])
    : [];
}

export function buildCtripHotelWaitScript(): string {
  return `new Promise((resolve) => {
    const detect = () => {
      if (location.pathname.includes('captcha') || /验证码|verify the human/i.test(document.body?.innerText || '')) return 'captcha';
      const hotels = window.__NEXT_DATA__?.props?.pageProps?.initListData?.hotelList;
      if (Array.isArray(hotels)) return 'content';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 5000);
  })`;
}

export function buildCtripHotelExtractScript(): string {
  return `(() => {
    const list = window.__NEXT_DATA__?.props?.pageProps?.initListData?.hotelList;
    return Array.isArray(list) ? list : null;
  })()`;
}

export function buildCtripFlightWaitScript(): string {
  return `new Promise((resolve) => {
    const detect = () => {
      if (location.pathname.includes('captcha') || /验证码|verify the human/i.test(document.body?.innerText || '')) return 'captcha';
      if (document.querySelector('.flight-list > span > div')) return 'content';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 8000);
  })`;
}

export function buildCtripScrollUntilScript(
  rowSelector: string,
  targetCount: number,
  maxScrolls = 8,
): string {
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 100) {
    throw new Error("targetCount must be an integer between 1 and 100.");
  }
  if (!Number.isInteger(maxScrolls) || maxScrolls < 1 || maxScrolls > 30) {
    throw new Error("maxScrolls must be an integer between 1 and 30.");
  }
  return `(async () => {
    const selector = ${JSON.stringify(rowSelector)};
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const countItems = () => Array.from(document.querySelectorAll(selector)).filter(isVisible).length;
    let lastCount = countItems();
    let plateauRounds = 0;
    for (let index = 0; index < ${maxScrolls}; index += 1) {
      if (countItems() >= ${targetCount}) break;
      const lastHeight = document.body.scrollHeight;
      window.scrollTo(0, lastHeight);
      await new Promise((resolve) => {
        let timeout;
        const observer = new MutationObserver(() => {
          if (document.body.scrollHeight > lastHeight) {
            clearTimeout(timeout);
            observer.disconnect();
            setTimeout(resolve, 200);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        timeout = setTimeout(() => { observer.disconnect(); resolve(null); }, 2500);
      });
      const newCount = countItems();
      if (newCount === lastCount) {
        plateauRounds += 1;
        if (plateauRounds >= 2) break;
      } else {
        plateauRounds = 0;
        lastCount = newCount;
      }
    }
    return countItems();
  })()`;
}

export function buildCtripFlightExtractScript(): string {
  return `(() => {
    const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const isTime = (value) => /^([01]?\\d|2[0-3]):[0-5]\\d$/.test(value);
    const isCurrency = (value) => /^[¥$€£]$/.test(value);
    const isPriceDigits = (value) => /^\\d+([.,]\\d+)?$/.test(value);
    const isFlightNo = (value) => /^[A-Z0-9]{2}\\d{3,4}[A-Z]?$/.test(value);
    const rows = [];
    document.querySelectorAll('.flight-list > span > div').forEach((card) => {
      const chunks = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            const text = cleanText(child.textContent);
            if (text) chunks.push(text);
          } else if (child.nodeType === 1) {
            walk(child);
          }
        }
      };
      walk(card);
      if (chunks.length < 8) return;
      const firstTimeIndex = chunks.findIndex(isTime);
      if (firstTimeIndex < 1) return;
      const airline = chunks[0];
      const flightNo = chunks[1] || null;
      if (!airline || !isFlightNo(flightNo)) return;
      const aircraft = chunks[2] && !isTime(chunks[2]) ? chunks[2] : null;
      const departureTime = chunks[firstTimeIndex];
      const departureAirport = chunks[firstTimeIndex + 1] || null;
      const arrivalTimeIndex = chunks.findIndex((chunk, index) => index > firstTimeIndex && isTime(chunk));
      if (arrivalTimeIndex < 0) return;
      const arrivalTime = chunks[arrivalTimeIndex];
      const arrivalAirport = chunks[arrivalTimeIndex + 1] || null;
      if (!departureAirport || !arrivalAirport) return;
      const terminal = /^T\\d$/.test(chunks[arrivalTimeIndex + 2] || '') ? chunks[arrivalTimeIndex + 2] : null;
      let price = null;
      let currency = null;
      for (let index = 0; index < chunks.length - 1; index += 1) {
        if (isCurrency(chunks[index]) && isPriceDigits(chunks[index + 1])) {
          currency = chunks[index];
          price = Number(chunks[index + 1].replace(',', ''));
          break;
        }
      }
      let cabin = null;
      for (let index = chunks.length - 1; index >= 0; index -= 1) {
        if (/舱$/.test(chunks[index])) {
          cabin = chunks[index];
          break;
        }
      }
      rows.push({ airline, flightNo, aircraft, departureTime, departureAirport, arrivalTime, arrivalAirport, terminal, price, currency, cabin });
    });
    return rows;
  })()`;
}

async function runSuggestCommand(
  kwargs: Record<string, unknown>,
  searchType: "D" | "H",
  emptyLabel: string,
): Promise<Record<string, unknown>[]> {
  const query = requireCtripQuery(kwargs.query);
  const limit = parseCtripLimit(kwargs.limit);
  const raw = await fetchCtripSuggest(query, searchType);
  const rows = raw
    .filter((item) => Boolean(item) && typeof item === "object")
    .slice(0, limit)
    .map(mapCtripSuggestRow)
    .filter((row) => row.name);
  if (!rows.length) throw new Error(`${emptyLabel} returned no data.`);
  return rows;
}

cli({
  site: "ctrip",
  name: "search",
  description:
    "Search Ctrip destinations, landmarks, scenic spots, and stations",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: SUGGEST_DEFAULT_LIMIT },
  ],
  columns: CTRIP_SUGGEST_COLUMNS,
  func: async (_page, kwargs) => runSuggestCommand(kwargs, "D", "ctrip search"),
});

cli({
  site: "ctrip",
  name: "hotel-suggest",
  description: "Search Ctrip hotel context suggestions",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: SUGGEST_DEFAULT_LIMIT },
  ],
  columns: CTRIP_SUGGEST_COLUMNS,
  func: async (_page, kwargs) =>
    runSuggestCommand(kwargs, "H", "ctrip hotel-suggest"),
});

cli({
  site: "ctrip",
  name: "hotel-search",
  description: "Search Ctrip hotel list by city and stay dates",
  domain: "hotels.ctrip.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "city", type: "int", required: true, positional: true },
    { name: "checkin", type: "str", required: true },
    { name: "checkout", type: "str", required: true },
    { name: "limit", type: "int", default: HOTEL_DEFAULT_LIMIT },
  ],
  columns: HOTEL_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const cityId = parseCtripCityId(kwargs.city);
    const checkin = parseCtripIsoDate("checkin", kwargs.checkin);
    const checkout = parseCtripIsoDate("checkout", kwargs.checkout);
    assertCtripCheckinBeforeCheckout(checkin, checkout);
    const limit = parseCtripLimit(
      kwargs.limit,
      HOTEL_DEFAULT_LIMIT,
      HOTEL_MAX_LIMIT,
    );
    const url = `https://hotels.ctrip.com/hotels/list?city=${cityId}&checkin=${checkin}&checkout=${checkout}`;
    await p.goto(url);
    const waitResult = await p.evaluate(buildCtripHotelWaitScript());
    if (waitResult === "captcha") {
      throw new Error(
        "Ctrip is asking for a captcha; complete it in the browser session and retry.",
      );
    }
    if (waitResult !== "content") {
      throw new Error(
        `Ctrip hotel-search page did not expose SSR hotel list (state=${String(waitResult)}).`,
      );
    }
    const raw = await p.evaluate(buildCtripHotelExtractScript());
    if (!Array.isArray(raw)) {
      throw new Error("Ctrip hotel-search returned malformed SSR hotel list.");
    }
    if (raw.length === 0) {
      throw new Error(
        `No hotels for city=${cityId} on ${checkin} to ${checkout}.`,
      );
    }
    const rows = raw
      .map((entry, index) => mapCtripHotelRow(entry as CtripHotelEntry, index))
      .filter((row) => row.hotelId && row.name)
      .slice(0, limit);
    if (!rows.length) {
      throw new Error(
        "Ctrip hotel-search SSR rows were missing required hotelId/name anchors.",
      );
    }
    return rows;
  },
});

cli({
  site: "ctrip",
  name: "flight",
  description: "Search Ctrip one-way flights by IATA route and date",
  domain: "flights.ctrip.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "from", type: "str", required: true, positional: true },
    { name: "to", type: "str", required: true, positional: true },
    { name: "date", type: "str", required: true },
    { name: "limit", type: "int", default: FLIGHT_DEFAULT_LIMIT },
  ],
  columns: FLIGHT_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const fromCode = parseCtripIataCode("from", kwargs.from);
    const toCode = parseCtripIataCode("to", kwargs.to);
    if (fromCode === toCode) {
      throw new Error(`--from and --to must differ (got ${fromCode}).`);
    }
    const date = parseCtripIsoDate("date", kwargs.date);
    const limit = parseCtripLimit(
      kwargs.limit,
      FLIGHT_DEFAULT_LIMIT,
      FLIGHT_MAX_LIMIT,
    );
    const url =
      `https://flights.ctrip.com/online/list/oneway-${fromCode.toLowerCase()}-${toCode.toLowerCase()}` +
      `?depdate=${date}&cabin=Y_S_C_F&adult=1&child=0&infant=0`;
    await p.goto(url);
    const waitResult = await p.evaluate(buildCtripFlightWaitScript());
    if (waitResult === "captcha") {
      throw new Error(
        "Ctrip is asking for a captcha; complete it in the browser session and retry.",
      );
    }
    if (waitResult !== "content") {
      throw new Error(
        `Ctrip flight page did not render flight cards (state=${String(waitResult)}).`,
      );
    }
    const renderedCardCount = await p.evaluate(
      buildCtripScrollUntilScript(".flight-list > span > div", limit),
    );
    const raw = await p.evaluate(buildCtripFlightExtractScript());
    if (!Array.isArray(raw)) {
      throw new Error("Ctrip flight DOM extraction returned malformed rows.");
    }
    if (raw.length === 0) {
      if (Number(renderedCardCount) > 0) {
        throw new Error(
          "Ctrip flight cards rendered but parser did not find required flight anchors.",
        );
      }
      throw new Error(`No flights for ${fromCode} to ${toCode} on ${date}.`);
    }
    const rows = raw
      .filter((row) => {
        const flight = row as CtripFlightRow;
        return (
          flight.departureTime &&
          flight.departureAirport &&
          flight.arrivalTime &&
          flight.arrivalAirport &&
          flight.airline &&
          flight.flightNo
        );
      })
      .slice(0, limit)
      .map((row, index) => {
        const flight = row as CtripFlightRow;
        return {
          rank: index + 1,
          airline: flight.airline,
          flightNo: flight.flightNo,
          aircraft: flight.aircraft,
          departureTime: flight.departureTime,
          departureAirport: flight.departureAirport,
          arrivalTime: flight.arrivalTime,
          arrivalAirport: flight.arrivalAirport,
          terminal: flight.terminal,
          price: flight.price,
          currency: flight.currency,
          cabin: flight.cabin,
          url,
        };
      });
    if (!rows.length) {
      throw new Error(
        "Ctrip flight rows were missing required airline/flight/time/airport anchors.",
      );
    }
    return rows;
  },
});
