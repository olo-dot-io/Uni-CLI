import { cli, Strategy } from "../../registry.js";

type JsonRecord = Record<string, unknown>;

const A_MARKET = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
const QUOTE_FIELDS =
  "f12,f13,f14,f2,f3,f4,f5,f6,f7,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23";

function clampInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.trunc(n), max));
}

async function fetchJson(url: URL | string): Promise<JsonRecord> {
  const resp = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 (compatible; Uni-CLI)",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${String(url)}`);
  return (await resp.json()) as JsonRecord;
}

function at(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as JsonRecord)[key] : undefined;
}

function rowsAt(data: unknown, path: string[]): JsonRecord[] {
  let cur = data;
  for (const key of path) cur = at(cur, key);
  return Array.isArray(cur) ? (cur as JsonRecord[]) : [];
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function sortSpec(
  key: string,
  specs: Record<string, { fid: string; order: "asc" | "desc" }>,
  fallback: string,
): { fid: string; order: "asc" | "desc" } {
  return specs[key] ?? specs[fallback]!;
}

function marketFs(key: string): string {
  const markets: Record<string, string> = {
    "hs-a": A_MARKET,
    "sh-a": "m:1+t:2,m:1+t:23",
    "sz-a": "m:0+t:6,m:0+t:80",
    "bj-a": "m:0+t:81+s:2048",
    cyb: "m:0+t:80",
    kcb: "m:1+t:23",
    hk: "m:116+t:3,m:116+t:4,m:116+t:1,m:116+t:2",
    us: "m:105,m:106,m:107",
  };
  return markets[key] ?? markets["hs-a"]!;
}

function clistUrl(config: {
  fs: string;
  fid: string;
  order: "asc" | "desc";
  limit: number;
  fields: string;
  ut?: string;
}): URL {
  const url = new URL("https://push2.eastmoney.com/api/qt/clist/get");
  url.searchParams.set("pn", "1");
  url.searchParams.set("pz", String(config.limit));
  url.searchParams.set("po", config.order === "desc" ? "1" : "0");
  url.searchParams.set("np", "1");
  url.searchParams.set("fltt", "2");
  url.searchParams.set("invt", "2");
  url.searchParams.set("fid", config.fid);
  url.searchParams.set("fs", config.fs);
  url.searchParams.set("fields", config.fields);
  url.searchParams.set("ut", config.ut ?? "bd1d9ddb04089700cf9c27f6f7426281");
  return url;
}

function resolveSecid(input: unknown): string {
  const raw = str(input).trim();
  if (!raw) throw new Error("symbol is required");
  const secid = raw.match(/^(\d{1,3})\.([A-Za-z0-9]+)$/);
  if (secid) return raw;
  const lower = raw.toLowerCase();
  const pref = lower.match(/^(sh|sz|bj)(\d{6})$/);
  if (pref) return `${pref[1] === "sh" ? "1" : "0"}.${pref[2]}`;
  const hk = lower.match(/^hk(\d{4,5})$/) ?? lower.match(/^(\d{4,5})\.hk$/);
  if (hk) return `116.${hk[1]!.padStart(5, "0")}`;
  const usPref = lower.match(/^us\.([a-z.-]+)$/);
  if (usPref) return `105.${usPref[1]!.toUpperCase()}`;
  if (/^\d{6}$/.test(raw)) {
    return /^(60|68|90|113|900)/.test(raw) ? `1.${raw}` : `0.${raw}`;
  }
  if (/^[A-Z.-]{1,8}$/.test(raw)) return `105.${raw}`;
  throw new Error(`unrecognized symbol: ${raw}`);
}

function secucode(input: unknown): string {
  const raw = str(input).trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(raw)) return raw;
  const pref = raw.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (pref) return `${pref[2]}.${pref[1]}`;
  if (/^\d{6}$/.test(raw)) {
    if (/^(60|68|90|113|900)/.test(raw)) return `${raw}.SH`;
    if (/^(4|8|920|83|87)/.test(raw)) return `${raw}.BJ`;
    return `${raw}.SZ`;
  }
  throw new Error(`unrecognized A-share symbol: ${raw}`);
}

function marketLabel(value: unknown): string {
  if (value === 1) return "SH";
  if (value === 0) return "SZ/BJ";
  if (value === 116) return "HK";
  if (value === 105 || value === 106 || value === 107) return "US";
  return str(value);
}

cli({
  site: "eastmoney",
  name: "quote",
  description: "东方财富个股实时行情（A股 / 港股 / 美股）",
  domain: "push2.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "symbols",
      type: "str",
      required: true,
      positional: true,
      description: "股票代码，支持逗号或空格分隔多个",
    },
  ],
  columns: ["code", "name", "market", "price", "changePercent", "turnover"],
  func: async (_page, kwargs) => {
    const raw = str(kwargs.symbols)
      .split(/[,，\s]+/)
      .filter(Boolean);
    const url = new URL("https://push2.eastmoney.com/api/qt/ulist.np/get");
    url.searchParams.set("secids", raw.map(resolveSecid).join(","));
    url.searchParams.set("fltt", "2");
    url.searchParams.set("fields", QUOTE_FIELDS);
    url.searchParams.set("ut", "bd1d9ddb04089700cf9c27f6f7426281");
    const diff = rowsAt(await fetchJson(url), ["data", "diff"]);
    return diff.map((it) => ({
      code: it.f12,
      name: it.f14,
      market: marketLabel(it.f13),
      price: it.f2,
      changePercent: it.f3,
      change: it.f4,
      open: it.f17,
      high: it.f15,
      low: it.f16,
      prevClose: it.f18,
      volume: it.f5,
      turnover: it.f6,
      turnoverRate: it.f8,
      amplitude: it.f7,
      peDynamic: it.f9,
      priceBook: it.f23,
      marketCap: it.f20,
      floatMarketCap: it.f21,
    }));
  },
});

cli({
  site: "eastmoney",
  name: "rank",
  description: "东方财富市场涨跌/成交排行（沪深/北证/港/美）",
  domain: "push2.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "market",
      type: "str",
      default: "hs-a",
      description: "hs-a/sh-a/sz-a/bj-a/cyb/kcb/hk/us",
    },
    {
      name: "sort",
      type: "str",
      default: "change",
      description: "change/drop/turnover/volume/amplitude/rate",
    },
    { name: "limit", type: "int", default: 20, description: "返回数量" },
  ],
  columns: ["rank", "code", "name", "price", "changePercent", "turnover"],
  func: async (_page, kwargs) => {
    const sorts = {
      change: { fid: "f3", order: "desc" },
      drop: { fid: "f3", order: "asc" },
      turnover: { fid: "f6", order: "desc" },
      volume: { fid: "f5", order: "desc" },
      amplitude: { fid: "f7", order: "desc" },
      rate: { fid: "f8", order: "desc" },
    } as const;
    const sort = sortSpec(str(kwargs.sort).toLowerCase(), sorts, "change");
    const rows = rowsAt(
      await fetchJson(
        clistUrl({
          fs: marketFs(str(kwargs.market).toLowerCase()),
          fid: sort.fid,
          order: sort.order,
          limit: clampInt(kwargs.limit, 20, 100),
          fields: QUOTE_FIELDS,
        }),
      ),
      ["data", "diff"],
    );
    return rows.map((it, i) => ({
      rank: i + 1,
      code: it.f12,
      name: it.f14,
      price: it.f2,
      changePercent: it.f3,
      change: it.f4,
      turnover: it.f6,
      volume: it.f5,
      turnoverRate: it.f8,
      peDynamic: it.f9,
      marketCap: it.f20,
    }));
  },
});

cli({
  site: "eastmoney",
  name: "etf",
  description: "东方财富 ETF 列表按成交额/涨跌幅排行",
  domain: "push2.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "sort",
      type: "str",
      default: "turnover",
      description: "turnover/change/drop/volume/rate",
    },
    { name: "limit", type: "int", default: 20, description: "返回数量" },
  ],
  columns: ["rank", "code", "name", "price", "changePercent", "turnover"],
  func: async (_page, kwargs) => {
    const sorts = {
      turnover: { fid: "f6", order: "desc" },
      change: { fid: "f3", order: "desc" },
      drop: { fid: "f3", order: "asc" },
      volume: { fid: "f5", order: "desc" },
      rate: { fid: "f8", order: "desc" },
    } as const;
    const sort = sortSpec(str(kwargs.sort).toLowerCase(), sorts, "turnover");
    const rows = rowsAt(
      await fetchJson(
        clistUrl({
          fs: "b:MK0021",
          fid: sort.fid,
          order: sort.order,
          limit: clampInt(kwargs.limit, 20, 100),
          fields: "f12,f14,f2,f3,f4,f5,f6,f8",
        }),
      ),
      ["data", "diff"],
    );
    return rows.map((it, i) => ({
      rank: i + 1,
      code: it.f12,
      name: it.f14,
      price: it.f2,
      changePercent: it.f3,
      change: it.f4,
      turnover: it.f6,
      volume: it.f5,
      turnoverRate: it.f8,
    }));
  },
});

cli({
  site: "eastmoney",
  name: "convertible",
  description: "东方财富可转债行情列表",
  domain: "push2.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "sort",
      type: "str",
      default: "turnover",
      description: "turnover/change/drop/price/premium/value/ytm",
    },
    { name: "limit", type: "int", default: 20, description: "返回数量" },
  ],
  columns: [
    "rank",
    "bondCode",
    "bondName",
    "bondPrice",
    "bondChangePct",
    "convPremiumPct",
  ],
  func: async (_page, kwargs) => {
    const sorts = {
      change: { fid: "f3", order: "desc" },
      drop: { fid: "f3", order: "asc" },
      turnover: { fid: "f6", order: "desc" },
      price: { fid: "f2", order: "desc" },
      premium: { fid: "f237", order: "desc" },
      value: { fid: "f236", order: "desc" },
      ytm: { fid: "f239", order: "desc" },
    } as const;
    const sort = sortSpec(str(kwargs.sort).toLowerCase(), sorts, "turnover");
    const rows = rowsAt(
      await fetchJson(
        clistUrl({
          fs: "b:MK0354",
          fid: sort.fid,
          order: sort.order,
          limit: clampInt(kwargs.limit, 20, 100),
          fields:
            "f12,f14,f2,f3,f6,f229,f230,f232,f234,f235,f236,f237,f238,f239,f243",
        }),
      ),
      ["data", "diff"],
    );
    return rows.map((it, i) => ({
      rank: i + 1,
      bondCode: it.f12,
      bondName: it.f14,
      bondPrice: it.f2,
      bondChangePct: it.f3,
      stockCode: it.f232,
      stockName: it.f234,
      convPrice: it.f235,
      convValue: it.f236,
      convPremiumPct: it.f237,
      remainingYears: it.f238,
      ytm: it.f239,
      listDate: str(it.f243),
    }));
  },
});

cli({
  site: "eastmoney",
  name: "sectors",
  description: "东方财富板块排行（行业/概念/地域）",
  domain: "push2.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "type",
      type: "str",
      default: "industry",
      description: "industry/concept/region",
    },
    {
      name: "sort",
      type: "str",
      default: "change",
      description: "change/drop/money-flow/out-flow/turnover",
    },
    { name: "limit", type: "int", default: 20, description: "返回数量" },
  ],
  columns: ["rank", "code", "name", "changePercent", "mainNet", "leadStock"],
  func: async (_page, kwargs) => {
    const sectorTypes: Record<string, string> = {
      industry: "m:90+t:2",
      concept: "m:90+t:3",
      region: "m:90+t:1",
    };
    const sorts = {
      change: { fid: "f3", order: "desc" },
      drop: { fid: "f3", order: "asc" },
      "money-flow": { fid: "f62", order: "desc" },
      "out-flow": { fid: "f62", order: "asc" },
      turnover: { fid: "f6", order: "desc" },
    } as const;
    const sort = sortSpec(str(kwargs.sort).toLowerCase(), sorts, "change");
    const rows = rowsAt(
      await fetchJson(
        clistUrl({
          fs:
            sectorTypes[str(kwargs.type).toLowerCase()] ??
            sectorTypes.industry!,
          fid: sort.fid,
          order: sort.order,
          limit: clampInt(kwargs.limit, 20, 100),
          fields: "f12,f14,f2,f3,f62,f104,f105,f128,f136,f140,f141",
          ut: "b2884a393a59ad64002292a3e90d46a5",
        }),
      ),
      ["data", "diff"],
    );
    return rows.map((it, i) => ({
      rank: i + 1,
      code: it.f12,
      name: it.f14,
      price: it.f2,
      changePercent: it.f3,
      mainNet: it.f62,
      leadStock: it.f128,
      leadChangePercent: it.f136,
      upCount: it.f104,
      downCount: it.f105,
    }));
  },
});

cli({
  site: "eastmoney",
  name: "index-board",
  description: "东方财富主要市场指数行情（A股 / 港股 / 美股）",
  domain: "push2.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "group",
      type: "str",
      default: "main",
      description: "main/hk/us/all",
    },
  ],
  columns: ["code", "name", "price", "changePercent", "change"],
  func: async (_page, kwargs) => {
    const groups: Record<string, string[]> = {
      main: [
        "1.000001",
        "0.399001",
        "0.399006",
        "1.000688",
        "1.000300",
        "1.000905",
      ],
      hk: ["100.HSI", "100.HSCEI", "100.HSTECH"],
      us: ["100.DJIA", "100.SPX", "100.NDX", "100.IXIC"],
    };
    const key = str(kwargs.group).toLowerCase();
    const secids =
      key === "all"
        ? Object.values(groups).flat()
        : (groups[key] ?? groups.main!);
    const url = new URL("https://push2.eastmoney.com/api/qt/ulist.np/get");
    url.searchParams.set("secids", secids.join(","));
    url.searchParams.set("fltt", "2");
    url.searchParams.set("fields", "f2,f3,f4,f12,f13,f14,f15,f16,f17,f18");
    url.searchParams.set("ut", "bd1d9ddb04089700cf9c27f6f7426281");
    return rowsAt(await fetchJson(url), ["data", "diff"]).map((it) => ({
      code: it.f12,
      name: it.f14,
      price: it.f2,
      changePercent: it.f3,
      change: it.f4,
      high: it.f15,
      low: it.f16,
      open: it.f17,
      prevClose: it.f18,
    }));
  },
});

cli({
  site: "eastmoney",
  name: "money-flow",
  description: "东方财富主力资金净流入排行",
  domain: "push2.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "range",
      type: "str",
      default: "today",
      description: "today/5d/10d",
    },
    { name: "order", type: "str", default: "desc", description: "desc/asc" },
    { name: "limit", type: "int", default: 20, description: "返回数量" },
  ],
  columns: ["rank", "code", "name", "price", "changePercent", "mainNet"],
  func: async (_page, kwargs) => {
    const ranges: Record<string, { fid: string; net: string; netPct: string }> =
      {
        today: { fid: "f62", net: "f62", netPct: "f184" },
        "5d": { fid: "f164", net: "f164", netPct: "f165" },
        "10d": { fid: "f174", net: "f174", netPct: "f175" },
      };
    const range = ranges[str(kwargs.range).toLowerCase()] ?? ranges.today!;
    const rows = rowsAt(
      await fetchJson(
        clistUrl({
          fs: A_MARKET,
          fid: range.fid,
          order: str(kwargs.order).toLowerCase() === "asc" ? "asc" : "desc",
          limit: clampInt(kwargs.limit, 20, 100),
          fields: [
            "f12",
            "f14",
            "f2",
            "f3",
            range.net,
            range.netPct,
            "f66",
            "f72",
            "f78",
            "f84",
          ].join(","),
          ut: "b2884a393a59ad64002292a3e90d46a5",
        }),
      ),
      ["data", "diff"],
    );
    return rows.map((it, i) => ({
      rank: i + 1,
      code: it.f12,
      name: it.f14,
      price: it.f2,
      changePercent: it.f3,
      mainNet: it[range.net],
      mainNetRatio: it[range.netPct],
      superNet: it.f66,
      bigNet: it.f72,
      mediumNet: it.f78,
      smallNet: it.f84,
    }));
  },
});

cli({
  site: "eastmoney",
  name: "northbound",
  description: "东方财富沪深港通北向/南向资金分时净流入",
  domain: "push2.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "direction",
      type: "str",
      default: "north",
      description: "north/south",
    },
    { name: "limit", type: "int", default: 10, description: "返回最近 N 分钟" },
  ],
  columns: ["time", "cumulativeNetYi", "minuteNetYi", "totalNetYi"],
  func: async (_page, kwargs) => {
    const url = new URL("https://push2.eastmoney.com/api/qt/kamtbs.rtmin/get");
    url.searchParams.set("fields1", "f1,f2,f3,f4");
    url.searchParams.set("fields2", "f51,f52,f54,f56");
    url.searchParams.set("ut", "b2884a393a59ad64002292a3e90d46a5");
    const key = ["south", "s"].includes(str(kwargs.direction).toLowerCase())
      ? "s2n"
      : "n2s";
    const rows = at(at(await fetchJson(url), "data"), key);
    const parsed = Array.isArray(rows)
      ? rows
          .map((r) => str(r).split(","))
          .filter((cols) => cols.length >= 4 && cols[1] !== "-")
      : [];
    return parsed
      .slice(-clampInt(kwargs.limit, 10, 240))
      .map(([time, cum, minute, total]) => ({
        time,
        cumulativeNetYi: +(Number(cum) / 10000).toFixed(4),
        minuteNetYi: +(Number(minute) / 10000).toFixed(4),
        totalNetYi: +(Number(total) / 10000).toFixed(4),
      }));
  },
});

cli({
  site: "eastmoney",
  name: "announcement",
  description: "东方财富上市公司公告",
  domain: "np-anotice-stock.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "market",
      type: "str",
      default: "SHA,SZA,BJA",
      description: "SHA/SZA/BJA，可逗号分隔",
    },
    { name: "limit", type: "int", default: 20, description: "返回数量" },
  ],
  columns: ["time", "code", "name", "title", "category", "url"],
  func: async (_page, kwargs) => {
    const url = new URL(
      "https://np-anotice-stock.eastmoney.com/api/security/ann",
    );
    url.searchParams.set("page_size", String(clampInt(kwargs.limit, 20, 100)));
    url.searchParams.set("page_index", "1");
    url.searchParams.set("ann_type", str(kwargs.market) || "SHA,SZA,BJA");
    url.searchParams.set("client_source", "web");
    url.searchParams.set("f_node", "0");
    url.searchParams.set("s_node", "0");
    return rowsAt(await fetchJson(url), ["data", "list"]).map((it) => {
      const codes = Array.isArray(it.codes) ? (it.codes as JsonRecord[]) : [];
      const columns = Array.isArray(it.columns)
        ? (it.columns as JsonRecord[])
        : [];
      const primary = codes[0] ?? {};
      return {
        time: str(it.notice_date ?? it.display_time).slice(0, 19),
        code: primary.stock_code ?? "",
        name: primary.short_name ?? "",
        title: it.title ?? it.title_ch ?? "",
        category: columns[0]?.column_name ?? "",
        url: `https://data.eastmoney.com/notices/detail/${str(primary.stock_code)}/${str(it.art_code)}.html`,
      };
    });
  },
});

cli({
  site: "eastmoney",
  name: "holders",
  description: "东方财富十大流通股东（A股 F10）",
  domain: "datacenter-web.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "symbol",
      type: "str",
      required: true,
      positional: true,
      description: "A股代码",
    },
    { name: "limit", type: "int", default: 10, description: "返回股东数" },
  ],
  columns: ["rank", "reportDate", "name", "holdNum", "floatRatio", "change"],
  func: async (_page, kwargs) => {
    const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
    url.searchParams.set("sortColumns", "END_DATE,HOLDER_RANK");
    url.searchParams.set("sortTypes", "-1,1");
    url.searchParams.set(
      "pageSize",
      String(Math.max(clampInt(kwargs.limit, 10, 50), 10)),
    );
    url.searchParams.set("pageNumber", "1");
    url.searchParams.set("reportName", "RPT_F10_EH_FREEHOLDERS");
    url.searchParams.set(
      "columns",
      "SECUCODE,SECURITY_CODE,END_DATE,HOLDER_RANK,HOLDER_NAME,HOLD_NUM,FREE_HOLDNUM_RATIO,HOLD_NUM_CHANGE",
    );
    url.searchParams.set("source", "HSF10");
    url.searchParams.set("client", "PC");
    url.searchParams.set("filter", `(SECUCODE="${secucode(kwargs.symbol)}")`);
    const rows = rowsAt(await fetchJson(url), ["result", "data"]);
    const latest = str(rows[0]?.END_DATE).slice(0, 10);
    return rows
      .filter((it) => str(it.END_DATE).slice(0, 10) === latest)
      .slice(0, clampInt(kwargs.limit, 10, 50))
      .map((it) => ({
        rank: it.HOLDER_RANK,
        reportDate: latest,
        name: it.HOLDER_NAME,
        holdNum: it.HOLD_NUM,
        floatRatio: it.FREE_HOLDNUM_RATIO,
        change: it.HOLD_NUM_CHANGE,
      }));
  },
});

cli({
  site: "eastmoney",
  name: "longhu",
  description: "东方财富龙虎榜明细",
  domain: "datacenter-web.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "date",
      type: "str",
      default: "",
      description: "开始交易日 YYYY-MM-DD",
    },
    { name: "limit", type: "int", default: 20, description: "返回数量" },
  ],
  columns: [
    "tradeDate",
    "code",
    "name",
    "closePrice",
    "changeRate",
    "netAmt",
    "reason",
  ],
  func: async (_page, kwargs) => {
    const date =
      str(kwargs.date) ||
      new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
    url.searchParams.set("sortColumns", "TRADE_DATE,SECURITY_CODE");
    url.searchParams.set("sortTypes", "-1,1");
    url.searchParams.set("pageSize", String(clampInt(kwargs.limit, 20, 100)));
    url.searchParams.set("pageNumber", "1");
    url.searchParams.set("reportName", "RPT_DAILYBILLBOARD_DETAILS");
    url.searchParams.set("columns", "ALL");
    url.searchParams.set("source", "WEB");
    url.searchParams.set("client", "WEB");
    url.searchParams.set("filter", `(TRADE_DATE>='${date}')`);
    return rowsAt(await fetchJson(url), ["result", "data"]).map((it) => ({
      tradeDate: str(it.TRADE_DATE).slice(0, 10),
      code: it.SECURITY_CODE,
      name: it.SECURITY_NAME_ABBR,
      closePrice: it.CLOSE_PRICE,
      changeRate: it.CHANGE_RATE,
      boardAmt: it.BILLBOARD_DEAL_AMT,
      buyAmt: it.BILLBOARD_BUY_AMT,
      sellAmt: it.BILLBOARD_SELL_AMT,
      netAmt: it.BILLBOARD_NET_AMT,
      reason: it.EXPLANATION,
    }));
  },
});

cli({
  site: "eastmoney",
  name: "kuaixun",
  description: "东方财富财经快讯",
  domain: "kuaixun.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 20, description: "返回数量" }],
  columns: ["time", "title", "summary", "url"],
  func: async (_page, kwargs) => {
    const url = new URL(
      "https://np-weblist.eastmoney.com/comm/web/getFastNewsList",
    );
    url.searchParams.set("client", "web");
    url.searchParams.set("page_index", "1");
    url.searchParams.set("page_size", String(clampInt(kwargs.limit, 20, 100)));
    return rowsAt(await fetchJson(url), ["data", "fastNewsList"]).map((it) => ({
      time: str(it.showTime ?? it.createTime).slice(0, 19),
      title: it.title ?? "",
      summary: it.summary ?? it.digest ?? "",
      url: it.url ?? "",
    }));
  },
});

cli({
  site: "eastmoney",
  name: "kline",
  description: "东方财富个股 K 线行情",
  domain: "push2his.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "symbol",
      type: "str",
      required: true,
      positional: true,
      description: "股票代码",
    },
    {
      name: "period",
      type: "str",
      default: "daily",
      description: "daily/weekly/monthly",
    },
    { name: "limit", type: "int", default: 20, description: "返回 K 线数" },
  ],
  columns: ["date", "open", "close", "high", "low", "volume", "amount"],
  func: async (_page, kwargs) => {
    const periods: Record<string, string> = {
      daily: "101",
      weekly: "102",
      monthly: "103",
    };
    const url = new URL(
      "https://push2his.eastmoney.com/api/qt/stock/kline/get",
    );
    url.searchParams.set("secid", resolveSecid(kwargs.symbol));
    url.searchParams.set("fields1", "f1,f2,f3,f4,f5,f6");
    url.searchParams.set(
      "fields2",
      "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    );
    url.searchParams.set(
      "klt",
      periods[str(kwargs.period).toLowerCase()] ?? "101",
    );
    url.searchParams.set("fqt", "1");
    url.searchParams.set("end", "20500101");
    url.searchParams.set("lmt", String(clampInt(kwargs.limit, 20, 500)));
    const rows = at(at(await fetchJson(url), "data"), "klines");
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const [date, open, close, high, low, volume, amount] =
        str(row).split(",");
      return { date, open, close, high, low, volume, amount };
    });
  },
});

cli({
  site: "eastmoney",
  name: "hot-rank",
  description: "东方财富热股榜（按成交额近似排序）",
  domain: "push2.eastmoney.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 20, description: "返回数量" }],
  columns: ["rank", "symbol", "name", "price", "changePercent", "heat", "url"],
  func: async (_page, kwargs) => {
    const rows = rowsAt(
      await fetchJson(
        clistUrl({
          fs: A_MARKET,
          fid: "f6",
          order: "desc",
          limit: clampInt(kwargs.limit, 20, 100),
          fields: "f12,f14,f2,f3,f6",
        }),
      ),
      ["data", "diff"],
    );
    return rows.map((it, i) => ({
      rank: i + 1,
      symbol: it.f12,
      name: it.f14,
      price: it.f2,
      changePercent: it.f3,
      heat: it.f6,
      url: `https://guba.eastmoney.com/list,${str(it.f12)}.html`,
    }));
  },
});
