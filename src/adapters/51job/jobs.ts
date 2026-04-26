import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

type JsonRecord = Record<string, unknown>;

const WE_ORIGIN = "https://we.51job.com";
const JOBS_ORIGIN = "https://jobs.51job.com";
const SEARCH_COLUMNS = [
  "rank",
  "jobId",
  "title",
  "salary",
  "city",
  "company",
  "companyId",
  "workYear",
  "degree",
  "issueDate",
  "url",
];

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function clamp(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.max(1, Math.min(Math.trunc(n), max))
    : fallback;
}

function pageOf(page: unknown): IPage {
  if (!page) throw new Error("browser page required");
  return page as IPage;
}

const CITY_CODES: Record<string, string> = {
  全国: "000000",
  all: "000000",
  北京: "010000",
  beijing: "010000",
  上海: "020000",
  shanghai: "020000",
  广州: "030200",
  guangzhou: "030200",
  深圳: "040000",
  shenzhen: "040000",
  杭州: "080200",
  hangzhou: "080200",
  成都: "090200",
  chengdu: "090200",
  南京: "070200",
  nanjing: "070200",
  武汉: "180200",
  wuhan: "180200",
};

function city(input: unknown): string {
  const value = str(input).trim();
  if (!value) return "000000";
  if (/^\d{6}$/.test(value)) return value;
  return CITY_CODES[value] ?? CITY_CODES[value.toLowerCase()] ?? "000000";
}

function searchUrl(config: {
  keyword: string;
  area: string;
  page: number;
  limit: number;
  sort: string;
}): string {
  const url = new URL(`${WE_ORIGIN}/api/job/search-pc`);
  url.searchParams.set("api_key", "51job");
  url.searchParams.set("timestamp", String(Date.now()));
  url.searchParams.set("keyword", config.keyword);
  url.searchParams.set("searchType", "2");
  url.searchParams.set("jobArea", config.area);
  url.searchParams.set(
    "sortType",
    config.sort === "最新" || config.sort === "new" ? "1" : "0",
  );
  url.searchParams.set("pageNum", String(config.page));
  url.searchParams.set("pageSize", String(config.limit));
  url.searchParams.set("source", "1");
  url.searchParams.set("accountId", "");
  url.searchParams.set("scene", "7");
  return url.toString();
}

async function browserJson(page: IPage, url: string): Promise<JsonRecord> {
  const payload = await page.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(url)}, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    const text = await response.text();
    return JSON.stringify({ ok: response.ok, status: response.status, text });
  })()`);
  const result = JSON.parse(str(payload)) as JsonRecord;
  if (!result.ok) throw new Error(`51job HTTP ${str(result.status)}`);
  if (str(result.text).trim().startsWith("<"))
    throw new Error("51job returned HTML challenge");
  return JSON.parse(str(result.text)) as JsonRecord;
}

function rows(data: JsonRecord): JsonRecord[] {
  const body = data.resultbody as JsonRecord | undefined;
  const job = body?.job as JsonRecord | undefined;
  return Array.isArray(job?.items) ? (job.items as JsonRecord[]) : [];
}

function mapJob(item: JsonRecord, rank: number): JsonRecord {
  return {
    rank,
    jobId: item.jobId ?? item.jobid ?? "",
    title: item.jobName ?? item.jobTitle ?? "",
    salary: item.providesalaryString ?? item.salary ?? "",
    city: item.jobAreaString ?? item.areaString ?? "",
    company: item.fullCompanyName ?? item.companyName ?? "",
    companyId: item.encCoId ?? item.companyId ?? "",
    workYear: item.workYearString ?? "",
    degree: item.degreeString ?? "",
    issueDate: item.issueDateString ?? item.updateDateTime ?? "",
    url: item.jobHref ?? item.jobUrl ?? "",
  };
}

async function searchJobs(
  page: IPage,
  kwargs: Record<string, unknown>,
  keyword: string,
): Promise<JsonRecord[]> {
  const limit = clamp(kwargs.limit, 20, 50);
  const pageNum = clamp(kwargs.page, 1, 1000);
  await page.goto(
    `${WE_ORIGIN}/pc/search?keyword=${encodeURIComponent(keyword)}&searchType=2`,
  );
  await page.wait(2);
  const data = await browserJson(
    page,
    searchUrl({
      keyword,
      area: city(kwargs.area),
      page: pageNum,
      limit,
      sort: str(kwargs.sort) || "综合",
    }),
  );
  return rows(data)
    .slice(0, limit)
    .map((item, i) => mapJob(item, (pageNum - 1) * limit + i + 1));
}

cli({
  site: "51job",
  name: "search",
  description: "51job 前程无忧关键词职位搜索",
  domain: "we.51job.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "keyword",
      type: "str",
      required: true,
      positional: true,
      description: "岗位、技能或公司关键词",
    },
    {
      name: "area",
      type: "str",
      default: "全国",
      description: "城市名或 6 位城市码",
    },
    { name: "sort", type: "str", default: "综合", description: "综合/最新" },
    { name: "page", type: "int", default: 1, description: "页码" },
    { name: "limit", type: "int", default: 20, description: "返回数量" },
  ],
  columns: SEARCH_COLUMNS,
  func: async (page, kwargs) =>
    searchJobs(pageOf(page), kwargs, str(kwargs.keyword)),
});

cli({
  site: "51job",
  name: "hot",
  description: "51job 推荐职位列表",
  domain: "we.51job.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "area",
      type: "str",
      default: "全国",
      description: "城市名或 6 位城市码",
    },
    { name: "sort", type: "str", default: "综合", description: "综合/最新" },
    { name: "page", type: "int", default: 1, description: "页码" },
    { name: "limit", type: "int", default: 20, description: "返回数量" },
  ],
  columns: SEARCH_COLUMNS,
  func: async (page, kwargs) => searchJobs(pageOf(page), kwargs, ""),
});

cli({
  site: "51job",
  name: "detail",
  description: "51job 职位详情（按 jobId）",
  domain: "jobs.51job.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "jobId",
      type: "str",
      required: true,
      positional: true,
      description: "职位 ID",
    },
  ],
  columns: [
    "jobId",
    "title",
    "salary",
    "location",
    "description",
    "company",
    "url",
  ],
  func: async (page, kwargs) => {
    const browser = pageOf(page);
    const jobId = str(kwargs.jobId);
    const url = `${JOBS_ORIGIN}/x/${jobId}.html`;
    await browser.goto(url);
    await browser.wait(2);
    const data = (await browser.evaluate(`(() => {
      const text = (selector) => document.querySelector(selector)?.innerText?.trim() || "";
      const company = document.querySelector(".cname a, .tCompany_sidebar .com_msg a");
      return JSON.stringify({
        title: text("h1") || text(".cn .name"),
        salary: text(".cn strong") || text("strong"),
        meta: text(".cn .msg.ltype") || text(".msg.ltype"),
        description: text(".bmsg.job_msg") || text(".job_msg"),
        company: company?.innerText?.trim() || "",
        companyUrl: company?.href || "",
        finalUrl: location.href
      });
    })()`)) as string;
    const row = JSON.parse(data) as JsonRecord;
    const [location, workYear, degree] = str(row.meta)
      .split("|")
      .map((part) => part.trim());
    return [
      {
        jobId,
        title: row.title,
        salary: row.salary,
        location,
        workYear,
        degree,
        description: row.description,
        company: row.company,
        companyUrl: row.companyUrl,
        url: row.finalUrl,
      },
    ];
  },
});

cli({
  site: "51job",
  name: "company",
  description: "51job 公司在招职位（按 encCoId）",
  domain: "jobs.51job.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "encCoId",
      type: "str",
      required: true,
      positional: true,
      description: "加密公司 ID",
    },
    { name: "limit", type: "int", default: 20, description: "返回职位数" },
  ],
  columns: SEARCH_COLUMNS,
  func: async (page, kwargs) => {
    const browser = pageOf(page);
    const encCoId = str(kwargs.encCoId);
    await browser.goto(`${JOBS_ORIGIN}/all/co${encCoId}.html`);
    await browser.wait(2);
    const raw =
      (await browser.evaluate(`(() => JSON.stringify([...document.querySelectorAll("a[sensorsdata]")]
      .filter((a) => /\\/\\d{6,}\\.html/.test(a.href || ""))
      .map((a) => ({ href: a.href, sensorsdata: a.getAttribute("sensorsdata") || "", text: a.innerText || "" }))))()`)) as string;
    const links = JSON.parse(raw) as Array<{
      href: string;
      sensorsdata: string;
      text: string;
    }>;
    const out: JsonRecord[] = [];
    for (const link of links) {
      try {
        const data = JSON.parse(link.sensorsdata) as JsonRecord;
        out.push({
          rank: out.length + 1,
          jobId: data.jobId ?? "",
          title: data.jobTitle ?? link.text.trim(),
          salary: data.jobSalary ?? "",
          city: data.jobArea ?? "",
          company: data.companyName ?? "",
          workYear: data.jobYear ?? "",
          degree: data.jobDegree ?? "",
          issueDate: data.jobTime ?? "",
          url: link.href,
        });
      } catch {
        continue;
      }
      if (out.length >= clamp(kwargs.limit, 20, 50)) break;
    }
    return out;
  },
});
