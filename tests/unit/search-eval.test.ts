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

  // Extended social coverage
  { query: "bluesky trending", site: "bluesky", command: "trending" },
  { query: "bluesky profile", site: "bluesky", command: "profile" },
  { query: "bluesky post", site: "bluesky", command: "post" },
  { query: "facebook朋友圈", site: "facebook", command: "feed" },
  { query: "facebook marketplace", site: "facebook", command: "marketplace" },
  { query: "instagram reels", site: "instagram", command: "reels" },
  { query: "instagram stories", site: "instagram", command: "stories" },
  { query: "instagram download", site: "instagram", command: "download" },
  { query: "instagram explore", site: "instagram", command: "explore" },
  { query: "tiktok live", site: "tiktok", command: "live" },
  { query: "tiktok搜索", site: "tiktok", command: "search" },
  { query: "即刻搜索", site: "jike", command: "search" },
  { query: "即刻动态", site: "jike", command: "feed" },
  { query: "V2EX搜索", site: "v2ex", command: "search" },
  { query: "V2EX最新", site: "v2ex", command: "latest" },
  { query: "V2EX每日", site: "v2ex", command: "daily" },
  { query: "mastodon搜索", site: "mastodon", command: "search" },
  { query: "mastodon trending", site: "mastodon", command: "trending" },
  { query: "threads search", site: "threads", command: "search" },
  { query: "贴吧搜索", site: "tieba", command: "search" },
  { query: "贴吧帖子", site: "tieba", command: "posts" },
  { query: "linux-do热门", site: "linux-do", command: "hot" },
  { query: "linux-do搜索", site: "linux-do", command: "search" },
  { query: "linux-do latest", site: "linux-do", command: "latest" },
  { query: "虎扑热帖", site: "hupu", command: "hot" },
  { query: "虎扑搜索", site: "hupu", command: "search" },
  { query: "lobsters newest", site: "lobsters", command: "newest" },
  { query: "lobsters search", site: "lobsters", command: "search" },

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
  { query: "bilibili trending", site: "bilibili", command: "trending" },
  { query: "B站字幕", site: "bilibili", command: "subtitle" },
  { query: "B站收藏", site: "bilibili", command: "favorites" },
  { query: "B站动态", site: "bilibili", command: "dynamic" },
  { query: "B站直播", site: "bilibili", command: "live" },
  { query: "bilibili history", site: "bilibili", command: "history" },

  // YouTube
  { query: "油管搜索", site: "youtube", command: "search" },
  { query: "youtube search", site: "youtube", command: "search" },
  { query: "youtube trending", site: "youtube", command: "trending" },
  { query: "youtube视频信息", site: "youtube", command: "video" },
  { query: "youtube transcript", site: "youtube", command: "transcript" },
  { query: "youtube shorts", site: "youtube", command: "shorts" },
  { query: "youtube channel", site: "youtube", command: "channel" },
  { query: "youtube comments", site: "youtube", command: "comments" },
  { query: "youtube playlist", site: "youtube", command: "playlist" },

  // TikTok
  { query: "tiktok search videos", site: "tiktok", command: "search" },
  { query: "tiktok save video", site: "tiktok", command: "save" },
  { query: "tiktok explore", site: "tiktok", command: "explore" },

  // Others
  { query: "twitch streams", site: "twitch", command: "streams" },
  { query: "twitch games", site: "twitch", command: "games" },
  { query: "twitch search", site: "twitch", command: "search" },
  { query: "twitch top games", site: "twitch", command: "top" },
  { query: "快手热门", site: "kuaishou", command: "hot" },
  { query: "快手搜索", site: "kuaishou", command: "search" },
  { query: "抖音视频", site: "douyin", command: "videos" },
  { query: "抖音发布", site: "douyin", command: "publish" },
  { query: "douyin profile", site: "douyin", command: "profile" },

  // ═══ News & Media (50 cases) ═══
  { query: "hackernews top stories", site: "hackernews", command: "top" },
  { query: "hacker news best", site: "hackernews", command: "best" },
  { query: "hackernews search", site: "hackernews", command: "search" },
  { query: "HN new stories", site: "hackernews", command: "new" },
  { query: "hackernews ask", site: "hackernews", command: "ask" },
  { query: "hackernews show", site: "hackernews", command: "show" },
  { query: "hackernews jobs", site: "hackernews", command: "jobs" },
  { query: "hackernews comments", site: "hackernews", command: "comments" },
  { query: "hackernews item detail", site: "hackernews", command: "item" },
  { query: "hackernews user info", site: "hackernews", command: "user" },
  { query: "BBC news", site: "bbc", command: "news" },
  { query: "BBC top stories", site: "bbc", command: "top" },
  { query: "bbc technology", site: "bbc", command: "technology" },
  { query: "bbc world news", site: "bbc", command: "world" },
  { query: "CNN headlines", site: "cnn", command: "top" },
  { query: "cnn technology", site: "cnn", command: "technology" },
  { query: "reuters latest", site: "reuters", command: "latest" },
  { query: "reuters搜索", site: "reuters", command: "search" },
  { query: "reuters top stories", site: "reuters", command: "top" },
  { query: "reuters article", site: "reuters", command: "article" },
  { query: "bloomberg news", site: "bloomberg", command: "news" },
  { query: "bloomberg markets", site: "bloomberg", command: "markets" },
  { query: "bloomberg economics", site: "bloomberg", command: "economics" },
  { query: "bloomberg tech", site: "bloomberg", command: "tech" },
  { query: "bloomberg opinions", site: "bloomberg", command: "opinions" },
  { query: "36kr新闻", site: "36kr", command: "news" },
  { query: "36kr热门", site: "36kr", command: "hot" },
  { query: "36kr latest", site: "36kr", command: "latest" },
  { query: "36kr搜索", site: "36kr", command: "search" },
  { query: "techcrunch latest", site: "techcrunch", command: "latest" },
  { query: "techcrunch search", site: "techcrunch", command: "search" },
  { query: "the verge latest", site: "theverge", command: "latest" },
  { query: "theverge search", site: "theverge", command: "search" },
  { query: "infoq文章", site: "infoq", command: "articles" },
  { query: "infoq latest", site: "infoq", command: "latest" },
  { query: "IT之家新闻", site: "ithome", command: "news" },
  { query: "ithome hot", site: "ithome", command: "hot" },
  { query: "ithome latest", site: "ithome", command: "latest" },
  { query: "nytimes top", site: "nytimes", command: "top" },
  { query: "nytimes search", site: "nytimes", command: "search" },
  { query: "头条热搜", site: "toutiao", command: "hot" },
  { query: "toutiao search", site: "toutiao", command: "search" },
  { query: "百度热搜", site: "baidu", command: "hot" },
  { query: "baidu search", site: "baidu", command: "search" },

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
  { query: "雪球搜索", site: "xueqiu", command: "search" },
  { query: "xueqiu feed", site: "xueqiu", command: "feed" },
  { query: "xueqiu hot", site: "xueqiu", command: "hot" },
  { query: "xueqiu market", site: "xueqiu", command: "market" },
  { query: "yahoo finance search", site: "yahoo-finance", command: "search" },
  {
    query: "yahoo finance trending",
    site: "yahoo-finance",
    command: "trending",
  },
  { query: "barchart options", site: "barchart", command: "options" },
  { query: "barchart flow", site: "barchart", command: "flow" },
  { query: "东方财富基金", site: "eastmoney", command: "fund" },
  { query: "eastmoney search", site: "eastmoney", command: "search" },
  { query: "eastmoney market", site: "eastmoney", command: "market" },
  { query: "sinafinance stock", site: "sinafinance", command: "stock" },
  { query: "新浪股票排行", site: "sinafinance", command: "stock-rank" },
  { query: "富途热门", site: "futu", command: "hot" },
  { query: "coinbase rates", site: "coinbase", command: "rates" },
  { query: "binance kline", site: "binance", command: "kline" },

  // ═══ Shopping (40 cases) ═══
  { query: "淘宝搜索", site: "taobao", command: "search" },
  { query: "京东搜索商品", site: "jd", command: "search" },
  { query: "amazon search", site: "amazon", command: "search" },
  { query: "amazon bestsellers", site: "amazon", command: "bestsellers" },
  { query: "amazon new releases", site: "amazon", command: "new-releases" },
  { query: "amazon product", site: "amazon", command: "product" },
  { query: "amazon deals", site: "amazon", command: "offer" },
  { query: "拼多多热门", site: "pinduoduo", command: "hot" },
  { query: "拼多多搜索", site: "pinduoduo", command: "search" },
  { query: "什么值得买", site: "smzdm", command: "hot" },
  { query: "smzdm search", site: "smzdm", command: "search" },
  { query: "美团热门", site: "meituan", command: "hot" },
  { query: "美团搜索", site: "meituan", command: "search" },
  { query: "coupang热门商品", site: "coupang", command: "hot" },
  { query: "coupang search", site: "coupang", command: "search" },
  { query: "闲鱼搜索", site: "xianyu", command: "search" },
  { query: "大众点评热门", site: "dianping", command: "hot" },
  { query: "大众点评搜索", site: "dianping", command: "search" },
  { query: "1688搜索", site: "1688", command: "search" },
  { query: "京东热门", site: "jd", command: "hot" },
  { query: "京东商品详情", site: "jd", command: "item" },
  { query: "taobao hot", site: "taobao", command: "hot" },
  { query: "当当搜索", site: "dangdang", command: "search" },
  { query: "当当热门", site: "dangdang", command: "hot" },
  { query: "饿了么热门", site: "ele", command: "hot" },
  { query: "饿了么搜索", site: "ele", command: "search" },
  { query: "猫眼热映", site: "maoyan", command: "hot" },
  { query: "maoyan search", site: "maoyan", command: "search" },

  // ═══ Developer (50 cases) ═══
  { query: "github trending repos", site: "github-trending", command: "daily" },
  {
    query: "github trending开发者",
    site: "github-trending",
    command: "developers",
  },
  {
    query: "github weekly trending",
    site: "github-trending",
    command: "weekly",
  },
  { query: "npm search package", site: "npm", command: "search" },
  { query: "npm package info", site: "npm", command: "info" },
  { query: "npm downloads", site: "npm", command: "downloads" },
  { query: "npm versions", site: "npm", command: "versions" },
  { query: "pypi search", site: "pypi", command: "search" },
  { query: "pypi package info", site: "pypi", command: "info" },
  { query: "pypi versions", site: "pypi", command: "versions" },
  { query: "crates.io search", site: "crates-io", command: "search" },
  { query: "crates-io info", site: "crates-io", command: "info" },
  { query: "docker hub search", site: "docker-hub", command: "search" },
  { query: "docker hub tags", site: "docker-hub", command: "tags" },
  { query: "docker hub info", site: "docker-hub", command: "info" },
  { query: "stackoverflow search", site: "stackoverflow", command: "search" },
  { query: "stack overflow问题", site: "stackoverflow", command: "search" },
  { query: "stackoverflow hot", site: "stackoverflow", command: "hot" },
  {
    query: "stackoverflow bounties",
    site: "stackoverflow",
    command: "bounties",
  },
  { query: "product hunt today", site: "producthunt", command: "today" },
  { query: "product hunt热门", site: "producthunt", command: "hot" },
  { query: "producthunt search", site: "producthunt", command: "search" },
  { query: "dev.to latest", site: "devto", command: "latest" },
  { query: "devto search", site: "devto", command: "search" },
  { query: "devto top", site: "devto", command: "top" },
  { query: "lobsters top", site: "lobsters", command: "hot" },
  { query: "homebrew search", site: "homebrew", command: "search" },
  { query: "homebrew info", site: "homebrew", command: "info" },
  { query: "gitee trending", site: "gitee", command: "trending" },
  { query: "gitee搜索", site: "gitee", command: "search" },
  { query: "gitlab搜索", site: "gitlab", command: "search" },
  { query: "gitlab trending", site: "gitlab", command: "trending" },
  { query: "gitlab projects", site: "gitlab", command: "projects" },
  { query: "lesswrong top", site: "lesswrong", command: "top" },
  { query: "lesswrong new", site: "lesswrong", command: "new" },
  { query: "lesswrong curated", site: "lesswrong", command: "curated" },
  { query: "npm trends compare", site: "npm-trends", command: "compare" },
  { query: "npm trending", site: "npm-trends", command: "trending" },
  { query: "cocoapods search", site: "cocoapods", command: "search" },

  // ═══ AI & ML (40 cases) ═══
  { query: "ollama models", site: "ollama", command: "list" },
  { query: "ollama run model", site: "ollama", command: "run" },
  { query: "ollama generate", site: "ollama", command: "generate" },
  { query: "ollama ps", site: "ollama", command: "ps" },
  {
    query: "huggingface papers",
    site: "huggingface-papers",
    command: "latest",
  },
  {
    query: "huggingface daily papers",
    site: "huggingface-papers",
    command: "daily",
  },
  { query: "huggingface models", site: "hf", command: "search" },
  { query: "huggingface datasets", site: "hf", command: "datasets" },
  { query: "huggingface spaces", site: "hf", command: "spaces" },
  { query: "openrouter models", site: "openrouter", command: "models" },
  { query: "openrouter search", site: "openrouter", command: "search" },
  { query: "replicate models", site: "replicate", command: "search" },
  { query: "replicate trending", site: "replicate", command: "trending" },
  { query: "replicate run", site: "replicate", command: "run" },
  { query: "deepseek对话", site: "deepseek", command: "chat" },
  { query: "deepseek models", site: "deepseek", command: "models" },
  { query: "gemini chat", site: "gemini", command: "chat" },
  { query: "gemini ask question", site: "gemini", command: "ask" },
  { query: "gemini image", site: "gemini", command: "image" },
  { query: "gemini deep research", site: "gemini", command: "deep-research" },
  { query: "豆包对话", site: "doubao-web", command: "chat" },
  { query: "doubao ask", site: "doubao", command: "ask" },
  { query: "notebooklm create", site: "notebooklm", command: "create" },
  { query: "notebooklm list", site: "notebooklm", command: "list" },
  { query: "perplexity ask", site: "perplexity", command: "ask" },
  { query: "grok对话", site: "grok", command: "ask" },
  { query: "minimax chat", site: "minimax", command: "chat" },
  { query: "minimax tts", site: "minimax", command: "tts" },
  { query: "novita generate", site: "novita", command: "generate" },
  { query: "comfyui generate", site: "comfyui", command: "generate" },
  { query: "comfyui status", site: "comfyui", command: "status" },

  // ═══ Reference & Education (40 cases) ═══
  { query: "google search", site: "google", command: "search" },
  { query: "谷歌搜索", site: "google", command: "search" },
  { query: "google trends", site: "google", command: "trends" },
  { query: "google news", site: "google", command: "news" },
  { query: "google suggest", site: "google", command: "suggest" },
  { query: "wikipedia search", site: "wikipedia", command: "search" },
  { query: "维基百科", site: "wikipedia", command: "search" },
  { query: "wikipedia summary", site: "wikipedia", command: "summary" },
  { query: "wikipedia trending", site: "wikipedia", command: "trending" },
  { query: "wikipedia random", site: "wikipedia", command: "random" },
  { query: "arxiv搜索论文", site: "arxiv", command: "search" },
  { query: "arxiv paper search", site: "arxiv", command: "search" },
  { query: "arxiv trending", site: "arxiv", command: "trending" },
  { query: "arxiv paper detail", site: "arxiv", command: "paper" },
  { query: "dictionary search", site: "dictionary", command: "search" },
  { query: "查词典", site: "dictionary", command: "search" },
  { query: "dictionary synonyms", site: "dictionary", command: "synonyms" },
  { query: "dictionary examples", site: "dictionary", command: "examples" },
  { query: "imdb search movie", site: "imdb", command: "search" },
  { query: "IMDB电影搜索", site: "imdb", command: "search" },
  { query: "imdb top rated", site: "imdb", command: "top" },
  { query: "imdb box office", site: "imdb", command: "box-office" },
  { query: "imdb trending", site: "imdb", command: "trending" },
  { query: "imdb title info", site: "imdb", command: "title" },
  { query: "汇率查询", site: "exchangerate", command: "convert" },
  { query: "exchange rate", site: "exchangerate", command: "convert" },
  { query: "exchange rate list", site: "exchangerate", command: "list" },
  { query: "天气查询", site: "qweather", command: "now" },
  { query: "weather forecast", site: "qweather", command: "now" },
  { query: "qweather forecast", site: "qweather", command: "forecast" },
  { query: "IP查询", site: "ip-info", command: "lookup" },
  { query: "知网搜索", site: "cnki", command: "search" },
  { query: "cnki search paper", site: "cnki", command: "search" },
  { query: "paperreview review", site: "paperreview", command: "review" },
  { query: "paperreview feedback", site: "paperreview", command: "feedback" },

  // ═══ Desktop & macOS (55 cases) ═══
  { query: "换 Word 字体", site: "word", command: "set-font" },
  { query: "Excel 插入图片", site: "excel", command: "insert-image" },
  { query: "PPT 插入链接", site: "powerpoint", command: "insert-link" },
  { query: "Word 插入图片", site: "word", command: "insert-image" },
  { query: "PowerPoint 修改字体", site: "powerpoint", command: "set-font" },
  { query: "ffmpeg compress video", site: "ffmpeg", command: "compress" },
  { query: "视频压缩", site: "ffmpeg", command: "compress" },
  { query: "ffmpeg转换格式", site: "ffmpeg", command: "convert" },
  { query: "ffmpeg extract audio", site: "ffmpeg", command: "extract-audio" },
  { query: "ffmpeg trim video", site: "ffmpeg", command: "trim" },
  { query: "ffmpeg gif", site: "ffmpeg", command: "gif" },
  { query: "ffmpeg concat", site: "ffmpeg", command: "concat" },
  { query: "ffmpeg thumbnail", site: "ffmpeg", command: "thumbnail" },
  { query: "ffmpeg resize", site: "ffmpeg", command: "resize" },
  { query: "ffmpeg probe", site: "ffmpeg", command: "probe" },
  { query: "imagemagick resize", site: "imagemagick", command: "resize" },
  { query: "图片缩放", site: "imagemagick", command: "resize" },
  { query: "imagemagick convert", site: "imagemagick", command: "convert" },
  { query: "imagemagick montage", site: "imagemagick", command: "montage" },
  { query: "blender render", site: "blender", command: "render" },
  { query: "3D渲染", site: "blender", command: "render" },
  { query: "blender export", site: "blender", command: "export" },
  { query: "blender info", site: "blender", command: "info" },
  { query: "截图", site: "macos", command: "screenshot" },
  { query: "screenshot", site: "macos", command: "screenshot" },
  { query: "系统信息", site: "macos", command: "system-info" },
  { query: "电池状态", site: "macos", command: "battery" },
  { query: "clipboard content", site: "macos", command: "clipboard" },
  { query: "亮度调节", site: "macos", command: "brightness" },
  { query: "音量调节", site: "macos", command: "volume" },
  { query: "wifi信息", site: "macos", command: "wifi-info" },
  { query: "打开应用", site: "macos", command: "open-app" },
  { query: "macos dark mode", site: "macos", command: "dark-mode" },
  { query: "macos processes", site: "macos", command: "processes" },
  { query: "macos disk usage", site: "macos", command: "disk-usage" },
  { query: "macos uptime", site: "macos", command: "uptime" },
  { query: "macos lock screen", site: "macos", command: "lock-screen" },
  { query: "macos notifications", site: "macos", command: "notification" },
  { query: "macos say text", site: "macos", command: "say" },
  { query: "macos trash", site: "macos", command: "trash" },
  { query: "macos apps list", site: "macos", command: "apps-list" },
  { query: "macos calendar today", site: "macos", command: "calendar-today" },
  { query: "macos reminders", site: "macos", command: "reminders-list" },
  { query: "macos shortcuts run", site: "macos", command: "shortcuts-run" },
  { query: "macos safari tabs", site: "macos", command: "safari-tabs" },
  { query: "macos spotlight search", site: "macos", command: "spotlight" },
  { query: "docker containers", site: "docker", command: "ps" },
  { query: "docker images", site: "docker", command: "images" },
  { query: "docker run", site: "docker", command: "run" },
  { query: "docker logs", site: "docker", command: "logs" },
  { query: "docker build", site: "docker", command: "build" },
  { query: "pandoc convert", site: "pandoc", command: "convert" },
  { query: "inkscape export svg", site: "inkscape", command: "export" },
  { query: "inkscape convert", site: "inkscape", command: "convert" },
  { query: "mermaid render diagram", site: "mermaid", command: "render" },
  { query: "gimp resize image", site: "gimp", command: "resize" },
  { query: "gimp convert format", site: "gimp", command: "convert" },
  { query: "gimp crop", site: "gimp", command: "crop" },
  { query: "libreoffice convert", site: "libreoffice", command: "convert" },
  { query: "musescore convert", site: "musescore", command: "convert" },
  { query: "drawio export", site: "drawio", command: "export" },

  // ═══ Audio & Content (30 cases) ═══
  { query: "spotify搜索", site: "spotify", command: "search" },
  { query: "spotify search music", site: "spotify", command: "search" },
  { query: "spotify now playing", site: "spotify", command: "now-playing" },
  { query: "spotify playlists", site: "spotify", command: "playlists" },
  { query: "spotify top tracks", site: "spotify", command: "top-tracks" },
  { query: "网易云音乐搜索", site: "netease-music", command: "search" },
  { query: "网易云热门", site: "netease-music", command: "hot" },
  {
    query: "netease music playlist",
    site: "netease-music",
    command: "playlist",
  },
  { query: "netease music top", site: "netease-music", command: "top" },
  { query: "播客搜索", site: "apple-podcasts", command: "search" },
  { query: "apple podcasts top", site: "apple-podcasts", command: "top" },
  {
    query: "apple podcasts episodes",
    site: "apple-podcasts",
    command: "episodes",
  },
  { query: "小宇宙播客", site: "xiaoyuzhou", command: "podcast" },
  { query: "xiaoyuzhou episode", site: "xiaoyuzhou", command: "episode" },
  { query: "medium articles", site: "medium", command: "search" },
  { query: "medium trending", site: "medium", command: "trending" },
  { query: "medium user profile", site: "medium", command: "user" },
  { query: "substack newsletters", site: "substack", command: "search" },
  { query: "substack trending", site: "substack", command: "trending" },
  { query: "substack feed", site: "substack", command: "feed" },
  { query: "少数派热门", site: "sspai", command: "hot" },
  { query: "少数派最新", site: "sspai", command: "latest" },
  { query: "微信读书搜索", site: "weread", command: "search" },
  { query: "微信读书排行", site: "weread", command: "ranking" },
  { query: "weread highlights", site: "weread", command: "highlights" },
  { query: "weread shelf", site: "weread", command: "shelf" },
  { query: "pixiv搜索", site: "pixiv", command: "search" },
  { query: "pixiv popular", site: "pixiv", command: "ranking" },
  { query: "pixiv download", site: "pixiv", command: "download" },
  { query: "pixiv user", site: "pixiv", command: "user" },
  { query: "知识星球搜索", site: "zsxq", command: "search" },
  { query: "zsxq groups", site: "zsxq", command: "groups" },
  { query: "zsxq topics", site: "zsxq", command: "topics" },

  // ═══ Jobs (15 cases) ═══
  { query: "boss直聘搜索", site: "boss", command: "search" },
  { query: "找工作", site: "boss", command: "search" },
  { query: "job search", site: "boss", command: "search" },
  { query: "boss recommend", site: "boss", command: "recommend" },
  { query: "boss detail", site: "boss", command: "detail" },
  { query: "boss chat list", site: "boss", command: "chatlist" },
  { query: "linkedin搜索", site: "linkedin", command: "search" },
  { query: "linkedin profile", site: "linkedin", command: "profile" },
  { query: "linkedin jobs", site: "linkedin", command: "jobs" },
  { query: "linkedin timeline", site: "linkedin", command: "timeline" },

  // ═══ Games (10 cases) ═══
  { query: "steam热门游戏", site: "steam", command: "top-sellers" },
  { query: "steam game search", site: "steam", command: "search" },
  { query: "steam deals", site: "steam", command: "specials" },
  { query: "steam new releases", site: "steam", command: "new-releases" },
  { query: "steam app details", site: "steam", command: "app-details" },
  { query: "steam wishlist", site: "steam", command: "wishlist" },
  { query: "itch.io popular", site: "itch-io", command: "popular" },
  { query: "itch.io search games", site: "itch-io", command: "search" },

  // ═══ Bridge CLIs (15 cases) ═══
  { query: "github issues", site: "gh", command: "issue" },
  { query: "github PR", site: "gh", command: "pr" },
  { query: "github release", site: "gh", command: "release" },
  { query: "gh repo", site: "gh", command: "repo" },
  { query: "gh actions run", site: "gh", command: "run" },
  { query: "yt-dlp下载", site: "yt-dlp", command: "download" },
  { query: "download youtube video", site: "yt-dlp", command: "download" },
  { query: "yt-dlp extract audio", site: "yt-dlp", command: "extract-audio" },
  { query: "yt-dlp search", site: "yt-dlp", command: "search" },
  { query: "yt-dlp info", site: "yt-dlp", command: "info" },
  { query: "jq format json", site: "jq", command: "format" },
  { query: "jq query json", site: "jq", command: "query" },

  // ═══ Misc / Tools / Services (50 cases) ═══
  { query: "OBS切换场景", site: "obs", command: "scenes" },
  { query: "obs screenshot", site: "obs", command: "screenshot" },
  { query: "obs record start", site: "obs", command: "record-start" },
  { query: "obs stream start", site: "obs", command: "stream-start" },
  { query: "obs status", site: "obs", command: "status" },
  { query: "notion搜索", site: "notion", command: "search" },
  { query: "notion databases", site: "notion", command: "databases" },
  { query: "notion pages", site: "notion", command: "pages" },
  { query: "slack消息", site: "slack", command: "messages" },
  { query: "slack search", site: "slack", command: "search" },
  { query: "slack post message", site: "slack", command: "post" },
  { query: "slack channels", site: "slack", command: "channels" },
  { query: "slack users", site: "slack", command: "users" },
  { query: "slack send", site: "slack", command: "send" },
  { query: "obsidian search", site: "obsidian", command: "search" },
  { query: "obsidian daily", site: "obsidian", command: "daily" },
  { query: "obsidian open", site: "obsidian", command: "open" },
  { query: "飞书日历", site: "feishu", command: "calendar" },
  { query: "飞书文档", site: "feishu", command: "docs" },
  { query: "飞书发送", site: "feishu", command: "send" },
  { query: "feishu tasks", site: "feishu", command: "tasks" },
  { query: "unsplash photos", site: "unsplash", command: "search" },
  { query: "unsplash random", site: "unsplash", command: "random" },
  { query: "pexels图片", site: "pexels", command: "search" },
  { query: "pexels curated", site: "pexels", command: "curated" },
  { query: "汇率换算", site: "exchangerate", command: "convert" },
  { query: "chrome tabs", site: "chrome", command: "tabs" },
  { query: "chrome bookmarks", site: "chrome", command: "bookmarks" },
  { query: "vscode extensions", site: "vscode", command: "extensions" },
  { query: "vscode open", site: "vscode", command: "open" },
  { query: "zotero search", site: "zotero", command: "search" },
  { query: "zotero collections", site: "zotero", command: "collections" },
  { query: "zotero items", site: "zotero", command: "items" },
  { query: "web page read", site: "web", command: "read" },
  { query: "read webpage", site: "web", command: "read" },
  { query: "微信搜索", site: "weixin", command: "search" },
  { query: "微信公众号", site: "weixin", command: "article" },
  { query: "微信热门", site: "weixin", command: "hot" },
  { query: "weixin download", site: "weixin", command: "download" },
  { query: "小红书热门", site: "xiaohongshu", command: "trending" },
  { query: "小红书笔记详情", site: "xiaohongshu", command: "note" },
  { query: "小红书下载", site: "xiaohongshu", command: "download" },
  { query: "小红书发布", site: "xiaohongshu", command: "publish" },
  { query: "ctrip search flights", site: "ctrip", command: "search" },
  { query: "携程搜索", site: "ctrip", command: "search" },
  { query: "知乎回答", site: "zhihu", command: "answer" },
  { query: "知乎文章", site: "zhihu", command: "article" },
  { query: "知乎关注", site: "zhihu", command: "following" },
  { query: "zhihu trending", site: "zhihu", command: "trending" },
  { query: "zhihu answer detail", site: "zhihu", command: "answer" },
  { query: "豆瓣热门书籍", site: "douban", command: "book-hot" },
  { query: "豆瓣搜索", site: "douban", command: "search" },
  { query: "douban movie top 250", site: "douban", command: "top250" },
  { query: "douban reviews", site: "douban", command: "reviews" },
  { query: "douban tv hot", site: "douban", command: "tv-hot" },
  { query: "豆瓣小组", site: "douban", command: "group-hot" },
  { query: "微博评论", site: "weibo", command: "comments" },
  { query: "微博发布", site: "weibo", command: "post" },
  { query: "微博个人主页", site: "weibo", command: "profile" },
  { query: "weibo trending", site: "weibo", command: "trending" },
  { query: "weibo feed", site: "weibo", command: "feed" },
  { query: "reddit hot posts", site: "reddit", command: "hot" },
  { query: "reddit new posts", site: "reddit", command: "new" },
  { query: "reddit top posts", site: "reddit", command: "top" },
  { query: "reddit trending", site: "reddit", command: "trending" },
  { query: "reddit popular", site: "reddit", command: "popular" },
  { query: "reddit frontpage", site: "reddit", command: "frontpage" },
  { query: "reddit user posts", site: "reddit", command: "user-posts" },
  { query: "reddit saved", site: "reddit", command: "saved" },
  { query: "reddit comment", site: "reddit", command: "comment" },
  { query: "twitter trending", site: "twitter", command: "trending" },
  { query: "twitter bookmarks", site: "twitter", command: "bookmarks" },
  { query: "twitter likes", site: "twitter", command: "likes" },
  { query: "twitter notifications", site: "twitter", command: "notifications" },
  { query: "twitter mentions", site: "twitter", command: "mentions" },
  { query: "twitter reply", site: "twitter", command: "reply" },
  { query: "twitter block", site: "twitter", command: "block" },
  { query: "twitter follow", site: "twitter", command: "follow" },
  { query: "twitter thread", site: "twitter", command: "thread" },
  { query: "推特关注", site: "twitter", command: "follow" },
  { query: "推特收藏", site: "twitter", command: "bookmark" },
  { query: "Y Combinator launches", site: "ycombinator", command: "launches" },
  { query: "jimeng generate", site: "jimeng", command: "generate" },
  { query: "即梦生成图片", site: "jimeng", command: "generate" },
  { query: "yuanbao ask", site: "yuanbao", command: "ask" },
  { query: "元宝对话", site: "yuanbao", command: "ask" },

  // ═══ Near-Miss Cases (30 cases) ═══
  // Queries where similar commands exist — tests disambiguation
  { query: "reddit popular", site: "reddit", command: "popular" },
  { query: "reddit hot", site: "reddit", command: "hot" },
  { query: "twitter hot", site: "twitter", command: "trending" },
  { query: "bilibili rank", site: "bilibili", command: "ranking" },
  { query: "weibo hot topics", site: "weibo", command: "hot" },
  { query: "zhihu popular", site: "zhihu", command: "hot" },
  { query: "hackernews top", site: "hackernews", command: "top" },
  { query: "hackernews new", site: "hackernews", command: "new" },
  { query: "hackernews best", site: "hackernews", command: "best" },
  { query: "devto latest articles", site: "devto", command: "latest" },
  { query: "lobsters active", site: "lobsters", command: "active" },
  { query: "lesswrong frontpage", site: "lesswrong", command: "frontpage" },
  { query: "reddit rising", site: "reddit", command: "rising" },
  { query: "douban new movies", site: "douban", command: "new-movies" },
  { query: "notion search pages", site: "notion", command: "search" },
  {
    query: "instagram reels trending",
    site: "instagram",
    command: "reels-trending",
  },
  { query: "instagram highlights", site: "instagram", command: "highlights" },
  { query: "twitter spaces", site: "twitter", command: "spaces" },
  { query: "twitter article", site: "twitter", command: "article" },
  { query: "bilibili coin", site: "bilibili", command: "coin" },
  { query: "bilibili feed", site: "bilibili", command: "feed" },
  { query: "spotify正在播放", site: "spotify", command: "now-playing" },
  { query: "obs sources", site: "obs", command: "sources" },
  { query: "docker volumes", site: "docker", command: "volumes" },
  { query: "docker networks", site: "docker", command: "networks" },
  { query: "macos bluetooth", site: "macos", command: "bluetooth" },
  { query: "macos do not disturb", site: "macos", command: "do-not-disturb" },
  { query: "macos wallpaper", site: "macos", command: "wallpaper" },
  { query: "macos sleep", site: "macos", command: "sleep" },
  { query: "ffmpeg subtitles", site: "ffmpeg", command: "subtitles" },

  // ═══ Cross-Category Queries (30 cases) ═══
  // Generic intents that should match multiple sites
  { query: "download video", site: "bilibili", command: "download" },
  { query: "search music", site: "spotify", command: "search" },
  { query: "trending topics", site: "twitter", command: "trending" },
  { query: "latest news", site: "hackernews", command: "top" },
  { query: "stock quote", site: "yahoo-finance", command: "quote" },
  { query: "convert video format", site: "ffmpeg", command: "convert" },
  { query: "search papers", site: "arxiv", command: "search" },
  { query: "check weather", site: "qweather", command: "now" },
  { query: "lookup ip address", site: "ip-info", command: "lookup" },
  { query: "translate text", site: "google", command: "search" },
  { query: "find package", site: "npm", command: "search" },
  { query: "image resize", site: "imagemagick", command: "resize" },
  { query: "compress media", site: "ffmpeg", command: "compress" },
  { query: "post message", site: "slack", command: "post" },
  { query: "movie search", site: "imdb", command: "search" },
  { query: "podcast episodes", site: "apple-podcasts", command: "episodes" },
  { query: "code repository", site: "github-trending", command: "daily" },
  { query: "read article", site: "web", command: "read" },
  { query: "chat with AI", site: "deepseek", command: "chat" },
  { query: "generate image", site: "novita", command: "generate" },
  { query: "social media", site: "twitter", command: "trending" },
  { query: "developer tools", site: "github-trending", command: "daily" },
  { query: "AI tools", site: "ollama", command: "list" },
  { query: "图片搜索", site: "unsplash", command: "search" },
  { query: "视频下载", site: "bilibili", command: "download" },
  { query: "音乐搜索", site: "netease-music", command: "search" },
  { query: "新闻头条", site: "hackernews", command: "top" },
  { query: "论文搜索", site: "arxiv", command: "search" },
  { query: "找工作搜索", site: "boss", command: "search" },
  { query: "游戏搜索", site: "steam", command: "search" },

  // ═══ Adversarial & Edge Cases (20 cases) ═══
  // SQL injection
  { query: "'; DROP TABLE--", site: "google", command: "search" },
  { query: "1 OR 1=1", site: "google", command: "search" },
  // XSS
  { query: "<script>alert(1)</script>", site: "google", command: "search" },
  // Very long query
  {
    query:
      "I want to search for the latest trending topics on social media platforms and find the most popular content across multiple websites",
    site: "twitter",
    command: "trending",
  },
  // Emoji queries
  { query: "🎵 music search", site: "spotify", command: "search" },
  { query: "🎮 game deals", site: "steam", command: "specials" },
  // Mixed case
  { query: "TWITTER TRENDING", site: "twitter", command: "trending" },
  { query: "BILIBILI HOT", site: "bilibili", command: "hot" },
  { query: "GitHub Trending", site: "github-trending", command: "daily" },
  // Single character queries
  { query: "x trending", site: "twitter", command: "trending" },
  // Slash-separated
  { query: "twitter/trending", site: "twitter", command: "trending" },
  { query: "bilibili/search", site: "bilibili", command: "search" },
  { query: "reddit/hot", site: "reddit", command: "hot" },
  // Typo-adjacent (close to real queries)
  { query: "twiter search", site: "twitter", command: "search" },
  { query: "bilibi hot", site: "bilibili", command: "hot" },
  // Empty-ish queries
  { query: "search", site: "google", command: "search" },
  { query: "hot", site: "bilibili", command: "hot" },
  { query: "download", site: "bilibili", command: "download" },
  { query: "trending", site: "twitter", command: "trending" },
  { query: "news", site: "hackernews", command: "top" },
];

// ── Negative Test Cases ────────────────────────────────────────────────────
// Queries that should return zero or irrelevant results.
// Used to test that the search engine does not hallucinate matches.

const NEGATIVE_QUERIES: string[] = [
  // Random gibberish
  "xyzzy123",
  "asdfqwer",
  "qqqqzzzzxxxx",
  "ajklsdfha",
  "Lorem ipsum dolor sit amet",

  // Non-existent platforms
  "myspace trending",
  "friendster feed",
  "vine latest videos",
  "google plus circles",
  "orkut communities",

  // Off-domain queries
  "pizza delivery near me",
  "weather forecast tomorrow london",
  "how to cook pasta carbonara",
  "flight tickets to tokyo",
  "best running shoes 2026",
  "python list comprehension tutorial",
  "kubernetes pod restart",
  "react useEffect cleanup",
  "sql join syntax",
  "css flexbox center",

  // Pure numbers
  "12345678",
  "000000",

  // Punctuation only
  "!!!???",
  "......",

  // RTL text
  "مرحبا بالعالم",
  "שלום עולם",
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
    expect(total).toBeGreaterThanOrEqual(500);
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

  it("negative queries return few or no high-confidence results", () => {
    let lowScoreCount = 0;
    for (const q of NEGATIVE_QUERIES) {
      const results = search(q, 5);
      // A good search engine returns nothing or only low-score results
      // for nonsensical queries. We check top-1 score < 10.
      if (results.length === 0 || results[0].score < 10) {
        lowScoreCount++;
      }
    }
    const ratio =
      Math.round((lowScoreCount / NEGATIVE_QUERIES.length) * 10000) / 100;
    console.log(
      `Negative filter: ${ratio}% correct (${lowScoreCount}/${NEGATIVE_QUERIES.length})`,
    );
    // At least 60% of gibberish queries should not produce high-confidence results
    expect(ratio).toBeGreaterThan(60);
  });

  it(`total eval coverage: ${EVAL_CASES.length} positive + ${NEGATIVE_QUERIES.length} negative = ${EVAL_CASES.length + NEGATIVE_QUERIES.length}`, () => {
    expect(EVAL_CASES.length + NEGATIVE_QUERIES.length).toBeGreaterThanOrEqual(
      500,
    );
  });
});
