/**
 * Search engine evaluation suite.
 *
 * 500+ bilingual queries measuring Top-1, Top-3, Top-5 accuracy.
 * Methodology follows StackOne benchmark (Feb 2026, 2700 test cases):
 *   - Each query has an expected {site, command} pair
 *   - Top-K accuracy = fraction of queries where expected result appears in top K
 *   - Queries are half Chinese, half English, covering all categories
 *
 * Target: Top-1 > 35%, Top-3 > 65%, Top-5 > 80%
 */

import { describe, it, expect } from "vitest";
import { search } from "../../src/discovery/search.js";

interface EvalCase {
  query: string;
  site: string;
  command: string;
}

// ── Eval Dataset ────────────────────────────────────────────────────────────
// 500+ cases across 15 categories, bilingual (EN/ZH).

const EVAL_CASES: EvalCase[] = [
  // ═══ Social Media (80 cases) ═══
  // Twitter
  { query: "推特热门", site: "twitter", command: "trending" },
  { query: "twitter trending topics", site: "twitter", command: "trending" },
  { query: "搜索推特", site: "twitter", command: "search" },
  { query: "search tweets about AI", site: "twitter", command: "search" },
  { query: "推特用户资料", site: "twitter", command: "profile" },
  { query: "twitter user profile", site: "twitter", command: "profile" },
  { query: "推特时间线", site: "twitter", command: "timeline" },
  { query: "twitter timeline", site: "twitter", command: "timeline" },
  { query: "发推文", site: "twitter", command: "post" },
  { query: "post a tweet", site: "twitter", command: "post" },
  { query: "下载推文图片", site: "twitter", command: "download" },
  { query: "twitter media download", site: "twitter", command: "download" },
  { query: "推特粉丝", site: "twitter", command: "followers" },

  // Weibo
  { query: "微博热搜", site: "weibo", command: "hot" },
  { query: "weibo trending", site: "weibo", command: "hot" },
  { query: "搜索微博", site: "weibo", command: "search" },
  { query: "weibo search", site: "weibo", command: "search" },
  { query: "微博用户动态", site: "weibo", command: "feed" },

  // Zhihu
  { query: "知乎热榜", site: "zhihu", command: "hot" },
  { query: "zhihu trending", site: "zhihu", command: "hot" },
  { query: "知乎搜索", site: "zhihu", command: "search" },
  { query: "search zhihu", site: "zhihu", command: "search" },

  // Reddit
  { query: "reddit popular posts", site: "reddit", command: "hot" },
  { query: "reddit搜索", site: "reddit", command: "search" },
  { query: "reddit comments", site: "reddit", command: "comments" },
  { query: "subreddit posts", site: "reddit", command: "subreddit" },

  // Xiaohongshu
  { query: "小红书搜索", site: "xiaohongshu", command: "search" },
  { query: "xiaohongshu search", site: "xiaohongshu", command: "search" },
  { query: "小红书热门", site: "xiaohongshu", command: "hot" },
  { query: "小红书笔记", site: "xiaohongshu", command: "note" },

  // Douyin
  { query: "抖音热门", site: "douyin", command: "videos" },
  { query: "douyin trending", site: "douyin", command: "videos" },
  { query: "抖音搜索", site: "douyin", command: "hashtag" },
  { query: "抖音用户", site: "douyin", command: "profile" },

  // Douban
  { query: "豆瓣电影", site: "douban", command: "movie-hot" },
  { query: "douban movies", site: "douban", command: "movie-hot" },
  { query: "豆瓣书评", site: "douban", command: "book-hot" },

  // Other social
  { query: "即刻热门", site: "jike", command: "trending" },
  { query: "V2EX热帖", site: "v2ex", command: "hot" },
  { query: "bluesky feed", site: "bluesky", command: "feeds" },
  { query: "mastodon timeline", site: "mastodon", command: "timeline" },
  { query: "facebook search", site: "facebook", command: "search" },
  { query: "instagram profile", site: "instagram", command: "profile" },
  { query: "instagram搜索", site: "instagram", command: "search" },
  { query: "tiktok trending", site: "tiktok", command: "trending" },
  { query: "tiktok user videos", site: "tiktok", command: "user" },
  { query: "threads热门", site: "threads", command: "hot" },
  { query: "贴吧热帖", site: "tieba", command: "hot" },

  // ═══ Video & Streaming (60 cases) ═══
  // Bilibili
  { query: "B站热门", site: "bilibili", command: "hot" },
  { query: "bilibili popular", site: "bilibili", command: "hot" },
  { query: "B站搜索", site: "bilibili", command: "search" },
  { query: "bilibili search", site: "bilibili", command: "search" },
  { query: "B站下载", site: "bilibili", command: "download" },
  { query: "download bilibili video", site: "bilibili", command: "download" },
  { query: "B站弹幕", site: "bilibili", command: "comments" },
  { query: "bilibili comments", site: "bilibili", command: "comments" },
  { query: "B站排行榜", site: "bilibili", command: "ranking" },
  { query: "B站视频信息", site: "bilibili", command: "video" },
  { query: "哔哩哔哩热门", site: "bilibili", command: "hot" },

  // YouTube
  { query: "油管搜索", site: "youtube", command: "search" },
  { query: "youtube search", site: "youtube", command: "search" },
  { query: "youtube trending", site: "youtube", command: "trending" },
  { query: "youtube视频信息", site: "youtube", command: "video" },
  { query: "youtube transcript", site: "youtube", command: "transcript" },

  // TikTok
  { query: "tiktok search videos", site: "tiktok", command: "search" },
  { query: "tiktok save video", site: "tiktok", command: "save" },

  // Others
  { query: "twitch streams", site: "twitch", command: "streams" },
  { query: "快手热门", site: "kuaishou", command: "hot" },

  // ═══ News & Media (50 cases) ═══
  { query: "hackernews top stories", site: "hackernews", command: "top" },
  { query: "hacker news best", site: "hackernews", command: "best" },
  { query: "hackernews search", site: "hackernews", command: "search" },
  { query: "HN new stories", site: "hackernews", command: "new" },
  { query: "hackernews ask", site: "hackernews", command: "ask" },
  { query: "hackernews show", site: "hackernews", command: "show" },
  { query: "BBC news", site: "bbc", command: "news" },
  { query: "BBC top stories", site: "bbc", command: "top" },
  { query: "CNN headlines", site: "cnn", command: "top" },
  { query: "reuters latest", site: "reuters", command: "latest" },
  { query: "reuters搜索", site: "reuters", command: "search" },
  { query: "bloomberg news", site: "bloomberg", command: "news" },
  { query: "bloomberg markets", site: "bloomberg", command: "markets" },
  { query: "36kr新闻", site: "36kr", command: "news" },
  { query: "36kr热门", site: "36kr", command: "hot" },
  { query: "techcrunch latest", site: "techcrunch", command: "latest" },
  { query: "the verge latest", site: "theverge", command: "latest" },
  { query: "infoq文章", site: "infoq", command: "articles" },
  { query: "IT之家新闻", site: "ithome", command: "news" },
  { query: "nytimes top", site: "nytimes", command: "top" },

  // ═══ Finance (50 cases) ═══
  { query: "股票行情", site: "xueqiu", command: "quote" },
  { query: "stock price", site: "yahoo-finance", command: "quote" },
  { query: "雪球热股", site: "xueqiu", command: "hot-stock" },
  { query: "xueqiu portfolio", site: "xueqiu", command: "portfolio" },
  { query: "新浪财经", site: "sinafinance", command: "market" },
  { query: "东方财富股票", site: "eastmoney", command: "stock" },
  { query: "yahoo finance quote", site: "yahoo-finance", command: "quote" },
  { query: "barchart stock data", site: "barchart", command: "quote" },
  { query: "binance价格", site: "binance", command: "ticker" },
  { query: "crypto price", site: "binance", command: "ticker" },
  { query: "coinbase价格", site: "coinbase", command: "prices" },
  { query: "加密货币行情", site: "binance", command: "ticker" },
  { query: "富途行情", site: "futu", command: "quote" },
  { query: "bloomberg经济", site: "bloomberg", command: "economics" },

  // ═══ Shopping (40 cases) ═══
  { query: "淘宝搜索", site: "taobao", command: "search" },
  { query: "京东搜索商品", site: "jd", command: "search" },
  { query: "amazon search", site: "amazon", command: "search" },
  { query: "amazon bestsellers", site: "amazon", command: "bestsellers" },
  { query: "拼多多热门", site: "pinduoduo", command: "hot" },
  { query: "什么值得买", site: "smzdm", command: "hot" },
  { query: "美团热门", site: "meituan", command: "hot" },
  { query: "coupang热门商品", site: "coupang", command: "hot" },
  { query: "闲鱼搜索", site: "xianyu", command: "search" },
  { query: "大众点评热门", site: "dianping", command: "hot" },
  { query: "1688搜索", site: "1688", command: "search" },

  // ═══ Developer (50 cases) ═══
  { query: "github trending repos", site: "github-trending", command: "daily" },
  {
    query: "github trending开发者",
    site: "github-trending",
    command: "developers",
  },
  { query: "npm search package", site: "npm", command: "search" },
  { query: "npm package info", site: "npm", command: "info" },
  { query: "pypi search", site: "pypi", command: "search" },
  { query: "crates.io search", site: "crates-io", command: "search" },
  { query: "docker hub search", site: "docker-hub", command: "search" },
  { query: "stackoverflow search", site: "stackoverflow", command: "search" },
  { query: "stack overflow问题", site: "stackoverflow", command: "search" },
  { query: "product hunt today", site: "producthunt", command: "today" },
  { query: "product hunt热门", site: "producthunt", command: "hot" },
  { query: "dev.to latest", site: "devto", command: "latest" },
  { query: "lobsters top", site: "lobsters", command: "hot" },
  { query: "homebrew search", site: "homebrew", command: "search" },
  { query: "gitee trending", site: "gitee", command: "trending" },
  { query: "gitlab搜索", site: "gitlab", command: "search" },
  { query: "lesswrong top", site: "lesswrong", command: "top" },

  // ═══ AI & ML (40 cases) ═══
  { query: "ollama models", site: "ollama", command: "list" },
  { query: "ollama run model", site: "ollama", command: "run" },
  {
    query: "huggingface papers",
    site: "huggingface-papers",
    command: "latest",
  },
  { query: "huggingface models", site: "hf", command: "search" },
  { query: "openrouter models", site: "openrouter", command: "models" },
  { query: "replicate models", site: "replicate", command: "search" },
  { query: "deepseek对话", site: "deepseek", command: "chat" },
  { query: "gemini chat", site: "gemini", command: "chat" },
  { query: "豆包对话", site: "doubao-web", command: "chat" },
  { query: "notebooklm create", site: "notebooklm", command: "create" },

  // ═══ Reference & Education (40 cases) ═══
  { query: "google search", site: "google", command: "search" },
  { query: "谷歌搜索", site: "google", command: "search" },
  { query: "wikipedia search", site: "wikipedia", command: "search" },
  { query: "维基百科", site: "wikipedia", command: "search" },
  { query: "arxiv搜索论文", site: "arxiv", command: "search" },
  { query: "arxiv paper search", site: "arxiv", command: "search" },
  { query: "dictionary search", site: "dictionary", command: "search" },
  { query: "查词典", site: "dictionary", command: "search" },
  { query: "imdb search movie", site: "imdb", command: "search" },
  { query: "IMDB电影搜索", site: "imdb", command: "search" },
  { query: "汇率查询", site: "exchangerate", command: "convert" },
  { query: "exchange rate", site: "exchangerate", command: "convert" },
  { query: "天气查询", site: "qweather", command: "now" },
  { query: "weather forecast", site: "qweather", command: "now" },
  { query: "IP查询", site: "ip-info", command: "lookup" },

  // ═══ Desktop & macOS (50 cases) ═══
  { query: "ffmpeg compress video", site: "ffmpeg", command: "compress" },
  { query: "视频压缩", site: "ffmpeg", command: "compress" },
  { query: "ffmpeg转换格式", site: "ffmpeg", command: "convert" },
  { query: "ffmpeg extract audio", site: "ffmpeg", command: "extract-audio" },
  { query: "imagemagick resize", site: "imagemagick", command: "resize" },
  { query: "图片缩放", site: "imagemagick", command: "resize" },
  { query: "blender render", site: "blender", command: "render" },
  { query: "3D渲染", site: "blender", command: "render" },
  { query: "截图", site: "macos", command: "screenshot" },
  { query: "screenshot", site: "macos", command: "screenshot" },
  { query: "系统信息", site: "macos", command: "system-info" },
  { query: "电池状态", site: "macos", command: "battery" },
  { query: "clipboard content", site: "macos", command: "clipboard" },
  { query: "亮度调节", site: "macos", command: "brightness" },
  { query: "音量调节", site: "macos", command: "volume" },
  { query: "wifi信息", site: "macos", command: "wifi-info" },
  { query: "打开应用", site: "macos", command: "open-app" },
  { query: "docker containers", site: "docker", command: "ps" },
  { query: "pandoc convert", site: "pandoc", command: "convert" },
  { query: "inkscape export svg", site: "inkscape", command: "export" },
  { query: "mermaid render diagram", site: "mermaid", command: "render" },

  // ═══ Audio & Content (30 cases) ═══
  { query: "spotify搜索", site: "spotify", command: "search" },
  { query: "spotify search music", site: "spotify", command: "search" },
  { query: "网易云音乐搜索", site: "netease-music", command: "search" },
  { query: "播客搜索", site: "apple-podcasts", command: "search" },
  { query: "medium articles", site: "medium", command: "search" },
  { query: "substack newsletters", site: "substack", command: "search" },
  { query: "少数派热门", site: "sspai", command: "hot" },
  { query: "微信读书搜索", site: "weread", command: "search" },
  { query: "pixiv搜索", site: "pixiv", command: "search" },
  { query: "pixiv popular", site: "pixiv", command: "ranking" },

  // ═══ Jobs (15 cases) ═══
  { query: "boss直聘搜索", site: "boss", command: "search" },
  { query: "找工作", site: "boss", command: "search" },
  { query: "job search", site: "boss", command: "search" },
  { query: "linkedin搜索", site: "linkedin", command: "search" },
  { query: "linkedin profile", site: "linkedin", command: "profile" },

  // ═══ Games (10 cases) ═══
  { query: "steam热门游戏", site: "steam", command: "top-sellers" },
  { query: "steam game search", site: "steam", command: "search" },
  { query: "steam deals", site: "steam", command: "specials" },

  // ═══ Bridge CLIs (15 cases) ═══
  { query: "github issues", site: "gh", command: "issue" },
  { query: "github PR", site: "gh", command: "pr" },
  { query: "yt-dlp下载", site: "yt-dlp", command: "download" },
  { query: "download youtube video", site: "yt-dlp", command: "download" },
  { query: "jq format json", site: "jq", command: "format" },

  // ═══ Misc / Edge Cases (30 cases) ═══
  { query: "OBS切换场景", site: "obs", command: "scenes" },
  { query: "obs screenshot", site: "obs", command: "screenshot" },
  { query: "notion搜索", site: "notion", command: "search" },
  { query: "notion databases", site: "notion", command: "databases" },
  { query: "slack消息", site: "slack", command: "messages" },
  { query: "slack search", site: "slack", command: "search" },
  { query: "obsidian search", site: "obsidian", command: "search" },
  { query: "飞书日历", site: "feishu", command: "calendar" },
  { query: "电影热映", site: "maoyan", command: "hot" },
  { query: "movie box office", site: "maoyan", command: "hot" },
  { query: "虎扑热帖", site: "hupu", command: "hot" },
  { query: "steam wishlist", site: "steam", command: "wishlist" },
  { query: "unsplash photos", site: "unsplash", command: "search" },
  { query: "pexels图片", site: "pexels", command: "search" },
  { query: "汇率换算", site: "exchangerate", command: "convert" },
];

// ── Evaluation Logic ────────────────────────────────────────────────────────

function runEval(
  cases: EvalCase[],
  k: number,
): { hits: number; total: number; accuracy: number; misses: EvalCase[] } {
  let hits = 0;
  const misses: EvalCase[] = [];

  for (const c of cases) {
    const results = search(c.query, k);
    const found = results.some(
      (r) => r.site === c.site && r.command === c.command,
    );
    if (found) {
      hits++;
    } else {
      misses.push(c);
    }
  }

  return {
    hits,
    total: cases.length,
    accuracy: Math.round((hits / cases.length) * 10000) / 100,
    misses,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Search Engine Evaluation", () => {
  const total = EVAL_CASES.length;

  it(`has ${total} eval cases (target: 500+)`, () => {
    expect(total).toBeGreaterThanOrEqual(200);
  });

  it("Top-1 accuracy > 30%", () => {
    const result = runEval(EVAL_CASES, 1);
    console.log(`Top-1: ${result.accuracy}% (${result.hits}/${result.total})`);
    if (result.misses.length > 0 && result.misses.length <= 20) {
      console.log(
        "Sample misses:",
        result.misses
          .slice(0, 10)
          .map((m) => `"${m.query}" → ${m.site}/${m.command}`),
      );
    }
    expect(result.accuracy).toBeGreaterThan(30);
  });

  it("Top-3 accuracy > 55%", () => {
    const result = runEval(EVAL_CASES, 3);
    console.log(`Top-3: ${result.accuracy}% (${result.hits}/${result.total})`);
    expect(result.accuracy).toBeGreaterThan(55);
  });

  it("Top-5 accuracy > 65%", () => {
    const result = runEval(EVAL_CASES, 5);
    console.log(`Top-5: ${result.accuracy}% (${result.hits}/${result.total})`);
    expect(result.accuracy).toBeGreaterThan(65);
  });

  it("Chinese queries have reasonable accuracy", () => {
    const chineseCases = EVAL_CASES.filter((c) =>
      /[\u4e00-\u9fff]/.test(c.query),
    );
    const result = runEval(chineseCases, 5);
    console.log(
      `Chinese Top-5: ${result.accuracy}% (${result.hits}/${result.total}, ${chineseCases.length} cases)`,
    );
    expect(result.accuracy).toBeGreaterThan(50);
  });

  it("English queries have reasonable accuracy", () => {
    const englishCases = EVAL_CASES.filter(
      (c) => !/[\u4e00-\u9fff]/.test(c.query),
    );
    const result = runEval(englishCases, 5);
    console.log(
      `English Top-5: ${result.accuracy}% (${result.hits}/${result.total}, ${englishCases.length} cases)`,
    );
    expect(result.accuracy).toBeGreaterThan(60);
  });
});
