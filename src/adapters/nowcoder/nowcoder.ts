import { cli, Strategy } from "../../registry.js";

type JsonRecord = Record<string, unknown>;

const BASE = "https://gw-c.nowcoder.com";
const POST_COLUMNS = [
  "rank",
  "title",
  "author",
  "school",
  "likes",
  "comments",
  "views",
  "id",
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

function at(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as JsonRecord)[key] : undefined;
}

function rowsAt(data: unknown, path: string[]): JsonRecord[] {
  let cur = data;
  for (const key of path) cur = at(cur, key);
  return Array.isArray(cur) ? (cur as JsonRecord[]) : [];
}

function stripHtml(value: unknown): string {
  return str(value)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

async function getJson(url: string): Promise<JsonRecord> {
  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; Uni-CLI)",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return (await resp.json()) as JsonRecord;
}

async function postJson(url: string, body: JsonRecord): Promise<JsonRecord> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; Uni-CLI)",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return (await resp.json()) as JsonRecord;
}

function successData(data: JsonRecord): unknown {
  if (data.success === false)
    throw new Error(str(data.msg) || "nowcoder API failed");
  return data.data;
}

function mapPost(item: JsonRecord, rank: number): JsonRecord {
  const moment = (at(item, "momentData") ??
    at(item, "contentData") ??
    {}) as JsonRecord;
  const user = (at(item, "userBrief") ?? {}) as JsonRecord;
  const freq = (at(item, "frequencyData") ?? {}) as JsonRecord;
  return {
    rank,
    title: at(moment, "title") ?? "",
    author: at(user, "nickname") ?? "",
    school: at(user, "educationInfo") ?? "",
    likes: at(freq, "likeCnt") ?? 0,
    comments: at(freq, "commentCnt") ?? at(freq, "totalCommentCnt") ?? 0,
    views: at(freq, "viewCnt") ?? 0,
    id: at(moment, "uuid") ?? at(moment, "id") ?? at(item, "contentId") ?? "",
  };
}

async function tabPosts(
  tabId: number,
  kwargs: Record<string, unknown>,
): Promise<JsonRecord[]> {
  const page = clamp(kwargs.page, 1, 1000);
  const limit = clamp(kwargs.limit, 15, 50);
  const data = await getJson(
    `${BASE}/api/sparta/home/tab/content?tabId=${tabId}&categoryType=1&pageNo=${page}&pageSize=${limit}`,
  );
  return rowsAt(successData(data), ["records"])
    .map((item, i) => mapPost(item, i + 1))
    .filter((row) => row.title);
}

cli({
  site: "nowcoder",
  name: "hot",
  description: "牛客热搜榜 / Nowcoder hot search ranking",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 10, description: "返回数量" }],
  columns: ["rank", "title", "heat"],
  func: async (_page, kwargs) =>
    rowsAt(
      successData(await getJson(`${BASE}/api/sparta/hot-search/hot-content`)),
      ["hotQuery"],
    )
      .slice(0, clamp(kwargs.limit, 10, 50))
      .map((item) => ({
        rank: item.rank,
        title: item.query,
        heat: item.hotValue,
      })),
});

cli({
  site: "nowcoder",
  name: "trending",
  description: "牛客热门帖子 / Nowcoder trending posts",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 10, description: "返回数量" }],
  columns: ["rank", "title", "heat", "id"],
  func: async (_page, kwargs) =>
    rowsAt(
      successData(await getJson(`${BASE}/api/sparta/hot-search/top-hot-pc`)),
      ["result"],
    )
      .slice(0, clamp(kwargs.limit, 10, 50))
      .map((item, i) => ({
        rank: i + 1,
        title: item.title,
        heat: item.hotValueFromDolphin,
        id: item.uuid ?? item.id ?? "",
      })),
});

cli({
  site: "nowcoder",
  name: "topics",
  description: "牛客热门讨论话题 / Nowcoder hot topics",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 10, description: "返回数量" }],
  columns: ["rank", "topic", "views", "posts", "heat", "id"],
  func: async (_page, kwargs) =>
    rowsAt(
      successData(await getJson(`${BASE}/api/sparta/subject/hot-subject`)),
      ["result"],
    )
      .slice(0, clamp(kwargs.limit, 10, 50))
      .map((item, i) => ({
        rank: i + 1,
        topic: item.content,
        views: item.viewCount,
        posts: item.momentCount,
        heat: item.hotValue,
        id: item.uuid ?? item.id ?? "",
      })),
});

cli({
  site: "nowcoder",
  name: "jobs",
  description: "牛客职业方向列表 / Nowcoder career categories",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [],
  columns: ["id", "career", "learners"],
  func: async () =>
    rowsAt(
      successData(
        await getJson(
          `${BASE}/api/sparta/company-question/careerJobLevel1List`,
        ),
      ),
      ["careerJobSelectors"],
    ).map((item) => ({
      id: item.id,
      career: item.name,
      learners: item.practiceCount ?? "",
    })),
});

cli({
  site: "nowcoder",
  name: "companies",
  description: "牛客面试题热门公司 / Nowcoder hot companies for interview prep",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "job", type: "str", default: "11002", description: "职业 ID" },
  ],
  columns: ["rank", "company", "companyId"],
  func: async (_page, kwargs) =>
    rowsAt(
      successData(
        await getJson(
          `${BASE}/api/sparta/company-question/hot-company-list?jobId=${str(kwargs.job) || "11002"}`,
        ),
      ),
      ["result"],
    ).map((item, i) => ({
      rank: i + 1,
      company: item.companyName,
      companyId: item.companyId,
    })),
});

cli({
  site: "nowcoder",
  name: "creators",
  description: "牛客创作者榜 / Nowcoder creator leaderboard",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 10, description: "返回数量" }],
  columns: ["rank", "nickname", "school", "level", "heat", "tag"],
  func: async (_page, kwargs) =>
    rowsAt(
      successData(await getJson(`${BASE}/api/sparta/content/creator/top-list`)),
      ["result"],
    )
      .slice(0, clamp(kwargs.limit, 10, 50))
      .map((item, i) => {
        const user = (item.userBrief ?? {}) as JsonRecord;
        return {
          rank: i + 1,
          nickname: user.nickname ?? "",
          school: user.educationInfo ?? "",
          level: user.honorLevelName ?? "",
          heat: item.hotValue,
          tag: item.tag ?? "",
        };
      }),
});

cli({
  site: "nowcoder",
  name: "recommend",
  description: "牛客推荐流 / Nowcoder recommended feed",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "page", type: "int", default: 1, description: "页码" },
    { name: "limit", type: "int", default: 15, description: "返回数量" },
  ],
  columns: POST_COLUMNS,
  func: async (_page, kwargs) => {
    const page = clamp(kwargs.page, 1, 1000);
    const limit = clamp(kwargs.limit, 15, 50);
    const rows = rowsAt(
      successData(
        await getJson(
          `${BASE}/api/sparta/home/recommend?page=${page}&size=${limit}`,
        ),
      ),
      ["records"],
    );
    return rows
      .map((item, i) => mapPost(item, i + 1))
      .filter((row) => row.title);
  },
});

cli({
  site: "nowcoder",
  name: "experience",
  description: "牛客面经帖子 / Nowcoder interview experience posts",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "page", type: "int", default: 1, description: "页码" },
    { name: "limit", type: "int", default: 15, description: "返回数量" },
  ],
  columns: POST_COLUMNS,
  func: async (_page, kwargs) => tabPosts(818, kwargs),
});

cli({
  site: "nowcoder",
  name: "referral",
  description: "牛客内推帖子 / Nowcoder referral posts",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "page", type: "int", default: 1, description: "页码" },
    { name: "limit", type: "int", default: 15, description: "返回数量" },
  ],
  columns: POST_COLUMNS,
  func: async (_page, kwargs) => tabPosts(861, kwargs),
});

cli({
  site: "nowcoder",
  name: "salary",
  description: "牛客薪资爆料帖子 / Nowcoder salary disclosure posts",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "page", type: "int", default: 1, description: "页码" },
    { name: "limit", type: "int", default: 15, description: "返回数量" },
  ],
  columns: POST_COLUMNS,
  func: async (_page, kwargs) => tabPosts(858, kwargs),
});

cli({
  site: "nowcoder",
  name: "papers",
  description: "牛客公司真题试卷 / Nowcoder interview question papers",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "job", type: "str", default: "11002", description: "职业 ID" },
    { name: "company", type: "str", default: "", description: "公司 ID" },
    { name: "limit", type: "int", default: 10, description: "返回数量" },
  ],
  columns: ["rank", "title", "company", "practitioners"],
  func: async (_page, kwargs) => {
    const limit = clamp(kwargs.limit, 10, 50);
    const body: JsonRecord = {
      jobId: Number(kwargs.job ?? 11002),
      page: 1,
      pageSize: limit,
    };
    if (kwargs.company) body.companyId = Number(kwargs.company);
    return rowsAt(
      successData(
        await postJson(
          `${BASE}/api/sparta/company-question/get-paper-list`,
          body,
        ),
      ),
      ["records"],
    ).map((item, i) => {
      const tag = (item.companyTag ?? {}) as JsonRecord;
      return {
        rank: i + 1,
        title: item.paperName ?? "",
        company: tag.name ?? "",
        practitioners: item.practiceCnt ?? 0,
      };
    });
  },
});

cli({
  site: "nowcoder",
  name: "practice",
  description: "牛客专项练习题库 / Nowcoder practice question categories",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "job", type: "str", default: "11226", description: "职业 ID" },
    { name: "limit", type: "int", default: 20, description: "返回数量" },
  ],
  columns: ["category", "subject", "total", "done", "remaining"],
  func: async (_page, kwargs) => {
    const data = successData(
      await getJson(
        `${BASE}/api/sparta/intelligent/getPCIntelligentList?jobId=${str(kwargs.job) || "11226"}`,
      ),
    );
    const out: JsonRecord[] = [];
    for (const tag of rowsAt(data, ["tags"])) {
      for (const item of Array.isArray(tag.items)
        ? (tag.items as JsonRecord[])
        : []) {
        out.push({
          category: tag.title ?? "recommended",
          subject: item.title,
          total: item.tcount,
          done: item.rcount,
          remaining: item.leftCount,
        });
      }
    }
    return out.slice(0, clamp(kwargs.limit, 20, 100));
  },
});

cli({
  site: "nowcoder",
  name: "search",
  description: "牛客全文搜索 / Nowcoder full-text search",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "搜索关键词",
    },
    {
      name: "type",
      type: "str",
      default: "all",
      description: "all/post/question/user/job",
    },
    { name: "limit", type: "int", default: 10, description: "返回数量" },
  ],
  columns: ["rank", "title", "author", "school", "content", "id"],
  func: async (_page, kwargs) => {
    const limit = clamp(kwargs.limit, 10, 50);
    const data = successData(
      await postJson(`${BASE}/api/sparta/pc/search`, {
        query: str(kwargs.query),
        type: str(kwargs.type) || "all",
        page: 1,
        pageSize: limit,
      }),
    );
    return rowsAt(data, ["records"])
      .map((item, i) => {
        const dataRow = (item.data ?? {}) as JsonRecord;
        const moment = (dataRow.momentData ?? {}) as JsonRecord;
        const content = (dataRow.contentData ?? {}) as JsonRecord;
        const user = (dataRow.userBrief ?? {}) as JsonRecord;
        return {
          rank: i + 1,
          title: moment.title ?? content.title ?? user.nickname ?? "",
          author: user.nickname ?? "",
          school: user.educationInfo ?? "",
          content: stripHtml(moment.content ?? content.content).slice(0, 300),
          id: moment.uuid ?? content.uuid ?? dataRow.contentId ?? "",
        };
      })
      .filter((row) => row.title);
  },
});

cli({
  site: "nowcoder",
  name: "suggest",
  description: "牛客搜索建议 / Nowcoder search suggestions",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "搜索关键词",
    },
  ],
  columns: ["rank", "suggestion", "type"],
  func: async (_page, kwargs) =>
    rowsAt(
      successData(
        await postJson(`${BASE}/api/sparta/search/suggest`, {
          query: str(kwargs.query),
        }),
      ),
      ["records"],
    ).map((item, i) => ({
      rank: i + 1,
      suggestion: item.name ?? "",
      type: item.typeName ?? "general",
    })),
});

cli({
  site: "nowcoder",
  name: "detail",
  description: "牛客帖子详情 / Nowcoder post detail by ID, UUID, or URL",
  domain: "www.nowcoder.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "帖子 ID、UUID 或 URL",
    },
  ],
  columns: [
    "title",
    "author",
    "school",
    "content",
    "likes",
    "comments",
    "views",
    "time",
    "location",
  ],
  func: async (_page, kwargs) => {
    const raw = str(kwargs.id);
    const match = raw.match(/discuss\/(\d+)/);
    const id = match?.[1] ?? raw;
    const endpoints =
      /[a-f]/i.test(id) && id.length > 20
        ? [`${BASE}/api/sparta/detail/moment-data/detail/${id}`]
        : [
            `${BASE}/api/sparta/detail/content-data/detail/${id}`,
            `${BASE}/api/sparta/detail/moment-data/detail/${id}`,
          ];
    for (const endpoint of endpoints) {
      const data = await getJson(endpoint);
      const detail = successData(data);
      if (!detail || typeof detail !== "object") continue;
      const row = detail as JsonRecord;
      const user = (row.userBrief ?? {}) as JsonRecord;
      const freq = (row.frequencyData ?? {}) as JsonRecord;
      return [
        {
          title: row.title ?? "(untitled)",
          author: user.nickname ?? "",
          school: user.educationInfo ?? "",
          content: stripHtml(row.content).slice(0, 500),
          likes: freq.likeCnt ?? 0,
          comments: freq.commentCnt ?? freq.totalCommentCnt ?? 0,
          views: freq.viewCnt ?? 0,
          time: row.createdAt
            ? new Date(String(row.createdAt)).toISOString().slice(0, 19)
            : "",
          location: row.ip4Location ?? "",
        },
      ];
    }
    throw new Error(`post not found: ${id}`);
  },
});

cli({
  site: "nowcoder",
  name: "notifications",
  description: "牛客未读消息摘要 / Nowcoder unread message summary",
  domain: "www.nowcoder.com",
  strategy: Strategy.COOKIE,
  args: [],
  columns: ["type", "unread"],
  func: async () => {
    const data = successData(
      await getJson(`${BASE}/api/sparta/message/pc/unread/detail`),
    ) as JsonRecord;
    return [
      { type: "system", unread: at(data.systemNotice, "unreadCount") ?? 0 },
      { type: "likes", unread: at(data.likeCollect, "unreadCount") ?? 0 },
      { type: "comments", unread: at(data.commentMessage, "unreadCount") ?? 0 },
      { type: "follows", unread: at(data.followMessage, "unreadCount") ?? 0 },
      { type: "messages", unread: at(data.privateMessage, "unreadCount") ?? 0 },
      {
        type: "job_apply",
        unread: at(data.nowPickJobApply, "unreadCount") ?? 0,
      },
      { type: "total", unread: at(data.total, "unreadCount") ?? 0 },
    ];
  },
});
