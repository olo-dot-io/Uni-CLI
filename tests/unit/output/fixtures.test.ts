import { describe, it, expect } from "vitest";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMd } from "../../../src/output/md.js";
import type {
  AgentEnvelope,
  AgentEnvelopeOk,
  AgentEnvelopeErr,
} from "../../../src/output/envelope.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "md",
);

interface Case {
  name: string;
  envelope: AgentEnvelope;
}

const CASES: Case[] = [
  // ── 1. twitter.mentions ──────────────────────────────────────────────────
  {
    name: "twitter.mentions.success",
    envelope: {
      ok: true,
      schema_version: "2",
      command: "twitter.mentions",
      meta: {
        duration_ms: 1842,
        count: 2,
        surface: "web",
        operator: "cdp-native",
        adapter_version: "2026.04",
      },
      data: [
        {
          rank: 1,
          id: "1912345678901234567",
          author: "alice_dev",
          text: "Hey @zenalexa love the new self-repair feature in Uni-CLI! Fixed a broken adapter in 10 seconds.",
          date: "2026-04-16",
          url: "https://x.com/alice_dev/status/1912345678901234567",
        },
        {
          rank: 2,
          id: "1912345678901234568",
          author: "bob_agent",
          text: "@zenalexa any plans to add an OpenAI adapter? Would be super useful for agent pipelines.",
          date: "2026-04-16",
          url: "https://x.com/bob_agent/status/1912345678901234568",
        },
      ],
      error: null,
    } satisfies AgentEnvelopeOk,
  },
  {
    name: "twitter.mentions.error",
    envelope: {
      ok: false,
      schema_version: "2",
      command: "twitter.mentions",
      meta: {
        duration_ms: 5012,
        surface: "web",
        operator: "cdp-native",
      },
      data: null,
      error: {
        code: "selector_miss",
        message:
          "Element article[data-testid='tweet'] not found after 4000ms on /notifications/mentions",
        adapter_path: "src/adapters/twitter/mentions.yaml",
        step: 3,
        suggestion:
          "Twitter UI may have changed. Run `unicli repair twitter mentions` to re-record the selector.",
        retryable: true,
        alternatives: ["unicli twitter list", "unicli twitter user <handle>"],
      },
    } satisfies AgentEnvelopeErr,
  },

  // ── 2. reddit.frontpage ──────────────────────────────────────────────────
  {
    name: "reddit.frontpage.success",
    envelope: {
      ok: true,
      schema_version: "2",
      command: "reddit.frontpage",
      meta: {
        duration_ms: 623,
        count: 2,
        surface: "web",
        operator: "fetch",
        adapter_version: "2026.04",
        pagination: { next_cursor: "t3_zyxwvu", has_more: true },
      },
      data: [
        {
          rank: 1,
          title:
            "Scientists discover new method for room-temperature superconductivity",
          subreddit: "r/science",
          score: 48712,
          comments: 2341,
          author: "quantumleap42",
          url: "https://www.nature.com/articles/s41586-026-01234-5",
        },
        {
          rank: 2,
          title:
            "I built a CLI tool that turns any website into a deterministic API for AI agents",
          subreddit: "r/programming",
          score: 31089,
          comments: 987,
          author: "unicli_fan",
          url: "https://github.com/olo-dot-io/uni-cli",
        },
      ],
      error: null,
    } satisfies AgentEnvelopeOk,
  },
  {
    name: "reddit.frontpage.error",
    envelope: {
      ok: false,
      schema_version: "2",
      command: "reddit.frontpage",
      meta: {
        duration_ms: 3201,
        surface: "web",
        operator: "fetch",
      },
      data: null,
      error: {
        code: "rate_limited",
        message:
          "Reddit API returned HTTP 429 Too Many Requests. Retry after 60 seconds.",
        adapter_path: "src/adapters/reddit/frontpage.yaml",
        step: 1,
        suggestion:
          "Back off and retry after 60 seconds. Consider adding a rate_limit step to the adapter.",
        retryable: true,
        alternatives: ["unicli reddit hot", "unicli reddit rising"],
      },
    } satisfies AgentEnvelopeErr,
  },

  // ── 3. bilibili.dynamic ───────────────────────────────────────────────────
  {
    name: "bilibili.dynamic.success",
    envelope: {
      ok: true,
      schema_version: "2",
      command: "bilibili.dynamic",
      meta: {
        duration_ms: 812,
        count: 2,
        surface: "web",
        operator: "fetch",
        adapter_version: "2026.04",
        pagination: { next_cursor: "offset_20", has_more: true },
      },
      data: [
        {
          type: "DYNAMIC_TYPE_AV",
          author: "影视飓风",
          text: "新视频上线！深度解析2026年最佳短片奖作品，看看导演是如何用光影讲故事的。",
          timestamp: 1713200000,
          id: "9423718650001",
        },
        {
          type: "DYNAMIC_TYPE_WORD",
          author: "老师好我叫何同学",
          text: "今天在实验室用 AI 生成了一段代码，然后用 Uni-CLI 把它直接部署到了服务器上，整个过程不到5分钟。",
          timestamp: 1713190000,
          id: "9423701230045",
        },
      ],
      error: null,
    } satisfies AgentEnvelopeOk,
  },
  {
    name: "bilibili.dynamic.error",
    envelope: {
      ok: false,
      schema_version: "2",
      command: "bilibili.dynamic",
      meta: {
        duration_ms: 441,
        surface: "web",
        operator: "fetch",
      },
      data: null,
      error: {
        code: "not_authenticated",
        message:
          "Bilibili API returned code -101: account not logged in. SESSDATA cookie is missing or expired.",
        adapter_path: "src/adapters/bilibili/dynamic.yaml",
        step: 1,
        suggestion:
          "Run `unicli auth setup bilibili` to refresh your cookies, then retry.",
        retryable: false,
        alternatives: ["unicli bilibili hot", "unicli bilibili trending"],
      },
    } satisfies AgentEnvelopeErr,
  },

  // ── 4. hackernews.top ────────────────────────────────────────────────────
  {
    name: "hackernews.top.success",
    envelope: {
      ok: true,
      schema_version: "2",
      command: "hackernews.top",
      meta: {
        duration_ms: 1107,
        count: 2,
        surface: "web",
        operator: "fetch",
        adapter_version: "2026.04",
      },
      data: [
        {
          rank: 1,
          title:
            "Show HN: Uni-CLI – turns any website into a deterministic API for AI agents",
          score: 1243,
          author: "zenalexa",
          comments: 312,
          url: "https://github.com/olo-dot-io/uni-cli",
        },
        {
          rank: 2,
          title: "Formal semantics for MCP: a type-theoretic analysis",
          score: 876,
          author: "proofcarry",
          comments: 198,
          url: "https://arxiv.org/abs/2604.01234",
        },
      ],
      error: null,
    } satisfies AgentEnvelopeOk,
  },
  {
    name: "hackernews.top.error",
    envelope: {
      ok: false,
      schema_version: "2",
      command: "hackernews.top",
      meta: {
        duration_ms: 8502,
        surface: "web",
        operator: "fetch",
      },
      data: null,
      error: {
        code: "network_error",
        message:
          "HN Firebase API request timed out after 8000ms. hacker-news.firebaseio.com unreachable.",
        adapter_path: "src/adapters/hackernews/top.yaml",
        step: 1,
        suggestion:
          "Check network connectivity. The Firebase endpoint may be temporarily unavailable. Retry in a few minutes.",
        retryable: true,
        alternatives: ["unicli hackernews new", "unicli hackernews ask"],
      },
    } satisfies AgentEnvelopeErr,
  },

  // ── 5. github-trending.daily ─────────────────────────────────────────────
  {
    name: "github-trending.daily.success",
    envelope: {
      ok: true,
      schema_version: "2",
      command: "github-trending.daily",
      meta: {
        duration_ms: 934,
        count: 2,
        surface: "web",
        operator: "fetch",
        adapter_version: "2026.04",
        pagination: { next_cursor: "page_2", has_more: true },
      },
      data: [
        {
          rank: 1,
          name: "olo-dot-io/uni-cli",
          description:
            "CLI for AI agents: turns any website into a deterministic API",
          language: "TypeScript",
          stars: 4821,
          forks: 312,
        },
        {
          rank: 2,
          name: "openai/openai-python",
          description: "The official Python library for the OpenAI API",
          language: "Python",
          stars: 3201,
          forks: 789,
        },
      ],
      error: null,
    } satisfies AgentEnvelopeOk,
  },
  {
    name: "github-trending.daily.error",
    envelope: {
      ok: false,
      schema_version: "2",
      command: "github-trending.daily",
      meta: {
        duration_ms: 2103,
        surface: "web",
        operator: "fetch",
      },
      data: null,
      error: {
        code: "api_error",
        message:
          "GitHub Search API returned 422 Unprocessable Entity: pushed date filter is invalid.",
        adapter_path: "src/adapters/github-trending/daily.yaml",
        step: 1,
        suggestion:
          "Update the pushed date filter in the adapter YAML. Run `unicli repair github-trending daily`.",
        retryable: false,
        alternatives: [
          "unicli github-trending weekly",
          "unicli github-trending monthly",
        ],
      },
    } satisfies AgentEnvelopeErr,
  },

  // ── 6. arxiv.search ──────────────────────────────────────────────────────
  {
    name: "arxiv.search.success",
    envelope: {
      ok: true,
      schema_version: "2",
      command: "arxiv.search",
      meta: {
        duration_ms: 1456,
        count: 2,
        surface: "web",
        operator: "fetch",
        adapter_version: "2026.04",
      },
      data: [
        {
          id: "https://arxiv.org/abs/2604.12986",
          title:
            "Cognitive-Executive Separation in Large Language Model Agents",
          authors: "Alice Chen, Bob Zhang, Carol Liu",
          published: "2026-04-15T00:00:00Z",
          summary:
            "We propose decoupling reasoning from acting in LLM agents to prevent the reasoning system from rationalizing its own actions. Our evaluation across 12 benchmarks shows a 23% improvement in task accuracy.",
        },
        {
          id: "https://arxiv.org/abs/2603.20313",
          title: "Semantic Tool Discovery: 99.6% Token Reduction via Retrieval",
          authors: "David Park, Eve Wang",
          published: "2026-03-28T00:00:00Z",
          summary:
            "We demonstrate that BM25 retrieval over a tool registry reduces token consumption by 99.6% versus loading all tool descriptions into context, without degrading task success rate.",
        },
      ],
      error: null,
    } satisfies AgentEnvelopeOk,
  },
  {
    name: "arxiv.search.error",
    envelope: {
      ok: false,
      schema_version: "2",
      command: "arxiv.search",
      meta: {
        duration_ms: 201,
        surface: "web",
        operator: "fetch",
      },
      data: null,
      error: {
        code: "invalid_input",
        message:
          "Search query is required but was empty. Provide a search term.",
        adapter_path: "src/adapters/arxiv/search.yaml",
        step: 1,
        suggestion:
          'Pass a non-empty query string: `unicli arxiv search "LLM agents"`',
        retryable: false,
        alternatives: ["unicli arxiv recent", "unicli arxiv category cs.AI"],
      },
    } satisfies AgentEnvelopeErr,
  },

  // ── 7. xiaohongshu.feed ──────────────────────────────────────────────────
  {
    name: "xiaohongshu.feed.success",
    envelope: {
      ok: true,
      schema_version: "2",
      command: "xiaohongshu.feed",
      meta: {
        duration_ms: 3821,
        count: 2,
        surface: "web",
        operator: "cdp-native",
        adapter_version: "2026.04",
      },
      data: [
        {
          id: "6620a1b2000000001e01abcd",
          title: "用 AI 帮我规划了一次完美的京都之旅",
          type: "normal",
          author: "旅行达人小林",
          likes: "12.4w",
          url: "https://www.xiaohongshu.com/explore/6620a1b2000000001e01abcd",
        },
        {
          id: "6620b2c3000000001e02efgh",
          title: "2026春季穿搭公式，显瘦又时髦",
          type: "video",
          author: "穿搭博主Anna",
          likes: "8.9w",
          url: "https://www.xiaohongshu.com/explore/6620b2c3000000001e02efgh",
        },
      ],
      error: null,
    } satisfies AgentEnvelopeOk,
  },
  {
    name: "xiaohongshu.feed.error",
    envelope: {
      ok: false,
      schema_version: "2",
      command: "xiaohongshu.feed",
      meta: {
        duration_ms: 8001,
        surface: "web",
        operator: "cdp-native",
      },
      data: null,
      error: {
        code: "selector_miss",
        message:
          "Pinia store action fetchFeeds not intercepted within 8000ms timeout on xiaohongshu.com/explore",
        adapter_path: "src/adapters/xiaohongshu/feed.yaml",
        step: 2,
        suggestion:
          "Xiaohongshu may have updated its Pinia store structure. Run `unicli repair xiaohongshu feed` to re-record the tap action.",
        retryable: true,
        alternatives: [
          "unicli xiaohongshu search <keyword>",
          "unicli xiaohongshu user <uid>",
        ],
      },
    } satisfies AgentEnvelopeErr,
  },

  // ── 8. zhihu.answers ─────────────────────────────────────────────────────
  {
    name: "zhihu.answers.success",
    envelope: {
      ok: true,
      schema_version: "2",
      command: "zhihu.answers",
      meta: {
        duration_ms: 742,
        count: 2,
        surface: "web",
        operator: "fetch",
        adapter_version: "2026.04",
      },
      data: [
        {
          rank: 1,
          question: "AI agent 和传统 RPA 有什么本质区别？",
          excerpt:
            "最核心的区别在于 AI agent 具备语义理解和自适应能力。传统 RPA 依赖固定的 DOM 选择器和像素坐标，一旦 UI 变化就会崩溃；而 AI agent 能通过可访问性树理解页面语义，自动适应布局变化。",
          voteup: 8934,
          comments: 423,
        },
        {
          rank: 2,
          question: "CLI 工具和 MCP 服务，哪个更适合 AI agent 的工具调用？",
          excerpt:
            "CLI 在 token 效率上有显著优势：MCP 工具描述通常占用 1500-3000 tokens，而 CLI 命令只需约 80 tokens。对于高频调用场景，CLI 是更经济的选择。",
          voteup: 6210,
          comments: 287,
        },
      ],
      error: null,
    } satisfies AgentEnvelopeOk,
  },
  {
    name: "zhihu.answers.error",
    envelope: {
      ok: false,
      schema_version: "2",
      command: "zhihu.answers",
      meta: {
        duration_ms: 389,
        surface: "web",
        operator: "fetch",
      },
      data: null,
      error: {
        code: "auth_required",
        message:
          "Zhihu API returned 401 Unauthorized. z_c0 cookie is missing or has expired.",
        adapter_path: "src/adapters/zhihu/answers.yaml",
        step: 1,
        suggestion:
          "Run `unicli auth setup zhihu` to refresh the z_c0 session cookie, then retry.",
        retryable: false,
        alternatives: ["unicli zhihu trending", "unicli zhihu question <id>"],
      },
    } satisfies AgentEnvelopeErr,
  },

  // ── 9. douban.book-hot ───────────────────────────────────────────────────
  {
    name: "douban.book-hot.success",
    envelope: {
      ok: true,
      schema_version: "2",
      command: "douban.book-hot",
      meta: {
        duration_ms: 567,
        count: 2,
        surface: "web",
        operator: "fetch",
        adapter_version: "2026.04",
      },
      data: [
        {
          title: "置身事内：中国政府与经济发展",
          rate: "9.1",
          url: "https://book.douban.com/subject/35546622/",
        },
        {
          title: "人类简史",
          rate: "9.0",
          url: "https://book.douban.com/subject/25985021/",
        },
      ],
      error: null,
    } satisfies AgentEnvelopeOk,
  },
  {
    name: "douban.book-hot.error",
    envelope: {
      ok: false,
      schema_version: "2",
      command: "douban.book-hot",
      meta: {
        duration_ms: 312,
        surface: "web",
        operator: "fetch",
      },
      data: null,
      error: {
        code: "upstream_error",
        message:
          "Douban returned HTTP 404 for /j/search_subjects. The hot-books endpoint has been removed.",
        adapter_path: "src/adapters/douban/book-hot.yaml",
        step: 1,
        suggestion:
          "This adapter is quarantined (endpoint removed 2026-04-15). Use `unicli douban book-search <keyword>` instead.",
        retryable: false,
        alternatives: [
          "unicli douban book-search <keyword>",
          "unicli douban book-rank",
        ],
      },
    } satisfies AgentEnvelopeErr,
  },

  // ── 10. notion.search ────────────────────────────────────────────────────
  {
    name: "notion.search.success",
    envelope: {
      ok: true,
      schema_version: "2",
      command: "notion.search",
      meta: {
        duration_ms: 488,
        count: 2,
        surface: "web",
        operator: "fetch",
        adapter_version: "2026.04",
      },
      data: [
        {
          rank: 1,
          title: "v0.213 Gagarin — Release Plan",
          type: "page",
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
        {
          rank: 2,
          title: "Agent Tool Design Principles",
          type: "block",
          id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        },
      ],
      error: null,
    } satisfies AgentEnvelopeOk,
  },
  {
    name: "notion.search.error",
    envelope: {
      ok: false,
      schema_version: "2",
      command: "notion.search",
      meta: {
        duration_ms: 621,
        surface: "web",
        operator: "fetch",
      },
      data: null,
      error: {
        code: "permission_denied",
        message:
          "Notion API returned 403 Forbidden. Session cookie is valid but lacks access to this workspace.",
        adapter_path: "src/adapters/notion/search.yaml",
        step: 1,
        suggestion:
          "Ensure you are logged in to the correct Notion workspace. Run `unicli auth setup notion` to refresh cookies.",
        retryable: false,
        alternatives: [
          "unicli notion page <id>",
          "unicli notion database <id>",
        ],
      },
    } satisfies AgentEnvelopeErr,
  },
];

describe("md golden fixtures", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const actual = renderMd(c.envelope);
      const fixturePath = join(FIXTURES_DIR, `${c.name}.md`);
      // Regenerate: UPDATE_FIXTURES=1 npx vitest run tests/unit/output/fixtures.test.ts
      if (process.env["UPDATE_FIXTURES"] === "1") {
        if (!existsSync(FIXTURES_DIR))
          mkdirSync(FIXTURES_DIR, { recursive: true });
        writeFileSync(fixturePath, actual);
        return;
      }
      const expected = readFileSync(fixturePath, "utf-8");
      expect(actual).toBe(expected);
    });
  }

  it("no stray fixture files (catches renamed/deleted cases)", () => {
    if (!existsSync(FIXTURES_DIR)) return; // first-run safety
    const onDisk = new Set(
      readdirSync(FIXTURES_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, "")),
    );
    const expected = new Set(CASES.map((c) => c.name));
    for (const f of onDisk) {
      if (!expected.has(f))
        throw new Error(`stray fixture: ${f}.md — delete or add to CASES`);
    }
  });
});
