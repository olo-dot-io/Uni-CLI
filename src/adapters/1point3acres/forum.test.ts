import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  ONEPOINT_BASE,
  ONEPOINT_FORUMS_COLUMNS,
  ONEPOINT_FORUM_COLUMNS,
  ONEPOINT_LATEST_COLUMNS,
  ONEPOINT_NOTIFICATION_COLUMNS,
  ONEPOINT_SEARCH_COLUMNS,
  ONEPOINT_THREAD_COLUMNS,
  ONEPOINT_THREAD_LIST_COLUMNS,
  ONEPOINT_USER_COLUMNS,
  decodeOnePointEntities,
  normalizeOnePointLimit,
  normalizeOnePointPositiveInteger,
  parseOnePointSearchList,
  parseOnePointThreadList,
} from "./forum.js";

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function stubFetch(html: string) {
  const fetchMock = vi
    .fn()
    .mockImplementation(() => Promise.resolve(htmlResponse(html)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function pageMock() {
  return {
    cookies: vi.fn().mockResolvedValue({ sid: "secret" }),
  };
}

function threadListHtml() {
  return `
    <tbody id="normalthread_100">
      <tr>
        <th><a href="forum-145-1.html" target="_blank">Interview</a><a class="xst">Senior Engineer OA</a></th>
        <td class="by"><cite><a class="xi2">Ada</a></cite><em><span title="2026-05-12 10:00"></span></em></td>
        <td class="num"><a class="xi2">3</a><em>99</em></td>
        <td class="by"><cite><a>Ben</a></cite><em><span title="2026-05-12 11:00"></span></em></td>
      </tr>
    </tbody>
  `;
}

describe("1point3acres agent-facing commands", () => {
  it("registers all surface 1point3acres commands with expected columns", () => {
    const expected = [
      ["digest", ONEPOINT_THREAD_LIST_COLUMNS, false],
      ["forum", ONEPOINT_FORUM_COLUMNS, false],
      ["forums", ONEPOINT_FORUMS_COLUMNS, false],
      ["hot", ONEPOINT_THREAD_LIST_COLUMNS, false],
      ["latest", ONEPOINT_LATEST_COLUMNS, false],
      ["notifications", ONEPOINT_NOTIFICATION_COLUMNS, true],
      ["search", ONEPOINT_SEARCH_COLUMNS, true],
      ["thread", ONEPOINT_THREAD_COLUMNS, false],
      ["user", ONEPOINT_USER_COLUMNS, false],
    ];
    for (const [name, columns, browser] of expected) {
      const command = resolveCommand("1point3acres", String(name))?.command;
      expect(command?.columns).toEqual(columns);
      expect(command?.browser).toBe(browser);
    }
  });

  it("validates integers and decodes common entities without silent clamps", () => {
    expect(normalizeOnePointPositiveInteger("2", 1, "page")).toBe(2);
    expect(normalizeOnePointLimit(undefined, 20, 50)).toBe(20);
    expect(decodeOnePointEntities("A&amp;B&#33;")).toBe("A&B!");
    expect(() => normalizeOnePointPositiveInteger(0, 1, "page")).toThrow(
      "positive integer",
    );
    expect(() => normalizeOnePointLimit(51, 20, 50)).toThrow("<= 50");
  });

  it("parses thread-list HTML and runs hot/latest/digest/forum commands", async () => {
    expect(parseOnePointThreadList(threadListHtml())).toEqual([
      expect.objectContaining({
        tid: "100",
        title: "Senior Engineer OA",
        forum: "Interview",
        author: "Ada",
        replies: 3,
        views: 99,
        lastReplyTime: "2026-05-12 11:00",
      }),
    ]);
    const fetchMock = stubFetch(threadListHtml());
    try {
      const hot = resolveCommand("1point3acres", "hot")?.command;
      const latest = resolveCommand("1point3acres", "latest")?.command;
      const digest = resolveCommand("1point3acres", "digest")?.command;
      const forum = resolveCommand("1point3acres", "forum")?.command;
      await expect(hot!.func!({} as never, { limit: 1 })).resolves.toEqual([
        expect.objectContaining({ rank: 1, tid: "100" }),
      ]);
      await expect(latest!.func!({} as never, { limit: 1 })).resolves.toEqual([
        expect.objectContaining({ rank: 1, postTime: "2026-05-12 10:00" }),
      ]);
      await expect(digest!.func!({} as never, { limit: 1 })).resolves.toEqual([
        expect.objectContaining({ rank: 1, tid: "100" }),
      ]);
      await expect(
        forum!.func!({} as never, { fid: "145", page: 2, limit: 1 }),
      ).resolves.toEqual([
        expect.objectContaining({ rank: 1, kind: "normal", tid: "100" }),
      ]);
      expect(fetchMock.mock.calls[3][0]).toBe(
        `${ONEPOINT_BASE}/forum-145-2.html`,
      );
      await expect(forum!.func!({} as never, { fid: "abc" })).rejects.toThrow(
        "numeric forum id",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists forum ids and filters names", async () => {
    const fetchMock = stubFetch(`
      <a href="forum-145-1.html" class="foo overflow-hidden bar">Interview</a>
      <a href="forum-198-1.html" class="foo overflow-hidden bar">Jobs</a>
      <a href="forum-145-1.html" class="foo overflow-hidden bar">Interview</a>
    `);
    try {
      const forums = resolveCommand("1point3acres", "forums")?.command;
      await expect(
        forums!.func!({} as never, { filter: "job" }),
      ).resolves.toEqual([
        {
          fid: "198",
          name: "Jobs",
          url: `${ONEPOINT_BASE}/forum-198-1.html`,
        },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(`${ONEPOINT_BASE}/forum.php`);
      expect(options).toEqual({
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0 Safari/537.36",
        },
        redirect: "follow",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("searches with browser cookies and parses Discuz search results", async () => {
    const searchHtml = `
      <li class="pbw" id="200">
        <h3><a href="forum.php?mod=viewthread&tid=200">Search Hit</a></h3>
        <p class="xg1">5 个回复 - 1,234 次查看</p>
        <p><span>2026-05-12</span><a href="space-uid-42.html">Ada</a><a href="forum-145-1.html">Interview</a></p>
      </li>
    `;
    expect(parseOnePointSearchList(searchHtml)).toEqual([
      expect.objectContaining({
        tid: "200",
        title: "Search Hit",
        replies: 5,
        views: 1234,
      }),
    ]);
    const fetchMock = stubFetch(searchHtml);
    try {
      const search = resolveCommand("1point3acres", "search")?.command;
      await expect(
        search!.func!(pageMock() as never, {
          query: "visa",
          fid: "145",
          limit: 1,
        }),
      ).resolves.toEqual([
        {
          rank: 1,
          tid: "200",
          title: "Search Hit",
          forum: "Interview",
          author: "Ada",
          replies: 5,
          views: 1234,
          postTime: "2026-05-12",
          url: `${ONEPOINT_BASE}/thread-200-1-1.html`,
        },
      ]);
      expect(fetchMock.mock.calls[0][0]).toContain("srchtxt=visa");
      expect(fetchMock.mock.calls[0][1].headers.Cookie).toBe("sid=secret");
      await expect(
        search!.func!(pageMock() as never, { query: " " }),
      ).rejects.toThrow("query cannot be empty");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads thread floors and prefixes the main post with the thread title", async () => {
    stubFetch(`
      <div id="postlist">
        <span id="thread_subject">Thread Title</span>
        <div id="post_300">
          <div class="authi"><a class="xi2">Ada</a><span title="2026-05-12 12:00"></span></div>
          <td id="postmessage_300">Hello<br>World</td>
        </div>
      </div>
    `);
    try {
      const thread = resolveCommand("1point3acres", "thread")?.command;
      await expect(
        thread!.func!({} as never, {
          tid: "200",
          page: 1,
          limit: 1,
          contentLimit: 50,
        }),
      ).resolves.toEqual([
        {
          floor: 1,
          pid: "300",
          author: "Ada",
          postTime: "2026-05-12 12:00",
          content: "[Thread Title]\nHello\nWorld",
          url: `${ONEPOINT_BASE}/forum.php?mod=redirect&goto=findpost&ptid=200&pid=300`,
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads user profiles and notifications", async () => {
    const user = resolveCommand("1point3acres", "user")?.command;
    stubFetch(`
      <title>Ada的个人资料</title>
      <p class="mtm"><a href="space-uid-42.html">Ada</a></p>
      <a href="home.php?mod=space&uid=42">uid</a>
      <li>用户组: Member</li><li>积分: 100</li><li>大米: 88</li>
      <li>帖子数: 12</li><li>主题数: 3</li><li>精华数: 1</li>
      <li>注册时间: 2024-01-01</li><li>最后访问: 2026-05-12</li>
    `);
    try {
      await expect(user!.func!({} as never, { who: "42" })).resolves.toEqual([
        {
          uid: "42",
          username: "Ada",
          group: "Member",
          credits: "100",
          rice: "88",
          posts: "12",
          threads: "3",
          digests: "1",
          registerTime: "2024-01-01",
          lastAccess: "2026-05-12",
          profileUrl: `${ONEPOINT_BASE}/space-uid-42.html`,
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    const notifications = resolveCommand(
      "1point3acres",
      "notifications",
    )?.command;
    stubFetch(`
      <dl class="cl">
        <dt><a>Ben</a></dt>
        <dd class="ntc_body">Replied to <a href="thread-200-1-1.html">your post</a></dd>
        <dd class="xg1">now</dd>
      </dl>
    `);
    try {
      await expect(
        notifications!.func!(pageMock() as never, { kind: "mypost", limit: 1 }),
      ).resolves.toEqual([
        {
          index: 1,
          from: "Ben",
          summary: "Replied to your post",
          time: "now",
          threadUrl: `${ONEPOINT_BASE}/thread-200-1-1.html`,
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
