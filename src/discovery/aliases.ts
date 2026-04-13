/**
 * Bilingual alias table for command discovery.
 *
 * Three alias categories enable Chinese↔English search:
 *   1. Site aliases — 推特→twitter, B站→bilibili
 *   2. Action verbs — 搜索→[search, find], 下载→[download]
 *   3. Domain terms — 股票→[stock, quote, finance]
 *
 * Used by the BM25 search engine to expand queries before scoring.
 * Curated for quality over quantity — ~200 entries covering common
 * agent intents across all supported categories.
 */

// ── Site Aliases ────────────────────────────────────────────────────────────
// Chinese name / abbreviation → canonical site identifier

export const SITE_ALIASES: ReadonlyMap<string, string> = new Map([
  // Chinese social
  ["推特", "twitter"],
  ["微博", "weibo"],
  ["知乎", "zhihu"],
  ["豆瓣", "douban"],
  ["贴吧", "tieba"],
  ["即刻", "jike"],
  ["小红书", "xiaohongshu"],
  ["抖音", "douyin"],
  ["快手", "kuaishou"],
  ["B站", "bilibili"],
  ["b站", "bilibili"],
  ["哔哩哔哩", "bilibili"],
  ["微信", "weixin"],
  ["飞书", "feishu"],
  ["钉钉", "dingtalk"],

  // Chinese finance
  ["雪球", "xueqiu"],
  ["东方财富", "eastmoney"],
  ["新浪财经", "sinafinance"],
  ["富途", "futu"],

  // Chinese shopping
  ["淘宝", "taobao"],
  ["京东", "jd"],
  ["拼多多", "pinduoduo"],
  ["闲鱼", "xianyu"],
  ["美团", "meituan"],
  ["大众点评", "dianping"],
  ["饿了么", "ele"],
  ["什么值得买", "smzdm"],
  ["当当", "dangdang"],

  // Chinese news/knowledge
  ["少数派", "sspai"],
  ["微信读书", "weread"],
  ["虎扑", "hupu"],
  ["知网", "cnki"],
  ["超星", "chaoxing"],

  // Chinese tech
  ["掘金", "juejin"],
  ["码云", "gitee"],

  // International social — common abbreviations
  ["twitter", "twitter"],
  ["x", "twitter"],
  ["reddit", "reddit"],
  ["fb", "facebook"],
  ["ins", "instagram"],
  ["ig", "instagram"],
  ["tg", "telegram"],
  ["yt", "youtube"],
  ["油管", "youtube"],
  ["脸书", "facebook"],

  // AI platforms
  ["deepseek", "deepseek"],
  ["豆包", "doubao"],
  ["通义千问", "qwen"],

  // Desktop
  ["photoshop", "gimp"],
  ["ps", "gimp"],
]);

// ── Action Verb Aliases ─────────────────────────────────────────────────────
// Intent verb → English canonical forms used in command names

export const ACTION_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  // Search intent
  ["搜索", ["search", "find", "query", "lookup"]],
  ["搜", ["search", "find"]],
  ["查找", ["search", "find", "lookup"]],
  ["查", ["search", "find", "check", "lookup"]],
  ["查询", ["search", "query", "lookup"]],
  ["检索", ["search", "retrieve"]],
  ["find", ["search", "find", "lookup"]],
  ["lookup", ["search", "find", "lookup"]],
  ["query", ["search", "query"]],

  // Download intent
  ["下载", ["download", "save"]],
  ["保存", ["save", "download", "export"]],
  ["导出", ["export", "save"]],
  ["save", ["save", "download", "export"]],

  // Browse / Read intent
  ["浏览", ["list", "browse", "feed"]],
  ["看", ["read", "view", "get"]],
  ["阅读", ["read", "view"]],
  ["读", ["read", "get"]],
  ["获取", ["get", "fetch", "read"]],
  ["get", ["get", "fetch", "read"]],
  ["fetch", ["fetch", "get"]],

  // List / Trending intent
  ["热门", ["trending", "hot", "popular", "top"]],
  ["热搜", ["trending", "hot"]],
  ["排行", ["rank", "top", "popular", "trending"]],
  ["排行榜", ["rank", "top", "chart"]],
  ["榜单", ["rank", "chart", "top"]],
  ["推荐", ["recommend", "feed", "popular"]],
  ["列表", ["list", "all"]],
  ["trending", ["trending", "hot", "popular"]],
  ["popular", ["popular", "hot", "trending"]],
  ["top", ["top", "popular", "trending", "hot"]],

  // Create / Post intent
  ["发布", ["post", "create", "publish"]],
  ["发", ["post", "send"]],
  ["写", ["write", "create", "post"]],
  ["评论", ["comment", "reply"]],
  ["回复", ["reply", "comment"]],
  ["post", ["post", "create", "publish"]],
  ["create", ["create", "post", "new"]],

  // User / Profile intent
  ["用户", ["user", "profile"]],
  ["个人", ["profile", "user", "me"]],
  ["关注", ["follow", "following", "followers"]],
  ["粉丝", ["followers", "fans"]],
  ["profile", ["profile", "user", "info"]],

  // Info / Detail intent
  ["详情", ["detail", "info", "get"]],
  ["信息", ["info", "detail", "about"]],
  ["detail", ["detail", "info", "get"]],

  // Play / Media intent
  ["播放", ["play", "stream"]],
  ["收听", ["play", "listen"]],
  ["play", ["play", "stream"]],

  // Delete / Remove intent
  ["删除", ["delete", "remove"]],
  ["移除", ["remove", "delete"]],
  ["delete", ["delete", "remove"]],
]);

// ── Domain Term Aliases ─────────────────────────────────────────────────────
// Subject domain → English terms that appear in command descriptions

export const DOMAIN_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  // Finance
  ["股票", ["stock", "quote", "ticker", "finance", "market"]],
  ["基金", ["fund", "finance", "portfolio"]],
  ["行情", ["quote", "market", "price", "ticker"]],
  ["汇率", ["exchange", "rate", "currency", "forex"]],
  ["加密货币", ["crypto", "coin", "token", "bitcoin"]],
  ["stock", ["stock", "quote", "ticker", "finance"]],
  ["crypto", ["crypto", "coin", "token", "bitcoin"]],
  ["finance", ["stock", "finance", "market", "quote"]],

  // Video / Media
  ["视频", ["video", "clip", "stream", "watch"]],
  ["弹幕", ["danmaku", "comment", "barrage"]],
  ["直播", ["live", "stream", "broadcast"]],
  ["音乐", ["music", "song", "audio", "playlist"]],
  ["播客", ["podcast", "audio", "episode"]],
  ["video", ["video", "clip", "stream"]],
  ["music", ["music", "song", "audio"]],
  ["podcast", ["podcast", "episode", "audio"]],

  // News / Content
  ["新闻", ["news", "article", "headline"]],
  ["文章", ["article", "post", "story"]],
  ["资讯", ["news", "feed", "updates"]],
  ["帖子", ["post", "thread", "topic"]],
  ["news", ["news", "article", "headline"]],
  ["article", ["article", "post", "story"]],

  // Tech / Dev
  ["代码", ["code", "repo", "source"]],
  ["仓库", ["repo", "repository", "project"]],
  ["包", ["package", "module", "library"]],
  ["开源", ["opensource", "repo", "github"]],
  ["code", ["code", "repo", "source"]],
  ["repo", ["repo", "repository", "project"]],
  ["package", ["package", "module", "library"]],

  // Shopping
  ["商品", ["product", "item", "goods"]],
  ["价格", ["price", "cost"]],
  ["优惠", ["deal", "coupon", "discount"]],
  ["订单", ["order", "purchase"]],
  ["product", ["product", "item", "goods"]],
  ["price", ["price", "cost", "deal"]],

  // Job / Career
  ["工作", ["job", "position", "career"]],
  ["招聘", ["job", "hire", "recruit"]],
  ["简历", ["resume", "cv"]],
  ["面试", ["interview"]],
  ["job", ["job", "position", "career", "hire"]],
  ["interview", ["interview"]],

  // Education
  ["论文", ["paper", "thesis", "article"]],
  ["学术", ["academic", "research", "scholar"]],
  ["课程", ["course", "class", "lesson"]],
  ["paper", ["paper", "thesis", "research"]],
  ["research", ["research", "paper", "academic"]],

  // Entertainment
  ["电影", ["movie", "film", "cinema", "hot", "maoyan"]],
  ["电视剧", ["drama", "tv", "series"]],
  ["游戏", ["game", "gaming", "steam"]],
  ["动漫", ["anime", "manga", "bangumi"]],
  ["小说", ["novel", "fiction", "read"]],
  ["movie", ["movie", "film", "hot"]],
  ["game", ["game", "gaming", "steam"]],

  // Weather / Utility
  ["天气", ["weather", "forecast", "temperature"]],
  ["翻译", ["translate", "translation"]],
  ["汇总", ["summary", "digest", "overview"]],
  ["weather", ["weather", "forecast"]],

  // macOS / Desktop
  ["截图", ["screenshot", "capture"]],
  ["剪贴板", ["clipboard", "paste", "copy"]],
  ["提醒", ["reminder", "alarm", "notification"]],
  ["日历", ["calendar", "event", "schedule"]],
  ["定时", ["schedule", "timer", "cron"]],
  ["screenshot", ["screenshot", "capture"]],
  ["clipboard", ["clipboard", "copy", "paste"]],
]);

// ── Category Mapping ────────────────────────────────────────────────────────
// Site → category for category-based boosting in search results

export const SITE_CATEGORIES: ReadonlyMap<string, string> = new Map([
  // Social
  ["twitter", "social"],
  ["weibo", "social"],
  ["zhihu", "social"],
  ["douban", "social"],
  ["jike", "social"],
  ["xiaohongshu", "social"],
  ["tieba", "social"],
  ["v2ex", "social"],
  ["linux-do", "social"],
  ["reddit", "social"],
  ["bluesky", "social"],
  ["mastodon", "social"],
  ["facebook", "social"],
  ["instagram", "social"],
  ["band", "social"],
  ["lobsters", "social"],
  ["hupu", "social"],

  // Video / Streaming
  ["bilibili", "video"],
  ["youtube", "video"],
  ["douyin", "video"],
  ["tiktok", "video"],
  ["twitch", "video"],
  ["kuaishou", "video"],
  ["douyu", "video"],

  // News
  ["hackernews", "news"],
  ["bbc", "news"],
  ["cnn", "news"],
  ["nytimes", "news"],
  ["reuters", "news"],
  ["36kr", "news"],
  ["techcrunch", "news"],
  ["theverge", "news"],
  ["infoq", "news"],
  ["ithome", "news"],
  ["bloomberg", "news"],

  // Finance
  ["xueqiu", "finance"],
  ["eastmoney", "finance"],
  ["sinafinance", "finance"],
  ["yahoo-finance", "finance"],
  ["barchart", "finance"],
  ["binance", "finance"],
  ["futu", "finance"],
  ["coinbase", "finance"],

  // Shopping
  ["amazon", "shopping"],
  ["jd", "shopping"],
  ["taobao", "shopping"],
  ["pinduoduo", "shopping"],
  ["1688", "shopping"],
  ["smzdm", "shopping"],
  ["meituan", "shopping"],
  ["coupang", "shopping"],
  ["xianyu", "shopping"],
  ["dianping", "shopping"],
  ["dangdang", "shopping"],
  ["ele", "shopping"],
  ["maoyan", "shopping"],

  // Developer
  ["github-trending", "dev"],
  ["gitlab", "dev"],
  ["gitee", "dev"],
  ["npm", "dev"],
  ["pypi", "dev"],
  ["crates-io", "dev"],
  ["cocoapods", "dev"],
  ["docker-hub", "dev"],
  ["npm-trends", "dev"],
  ["homebrew", "dev"],
  ["stackoverflow", "dev"],
  ["devto", "dev"],
  ["producthunt", "dev"],

  // AI
  ["ollama", "ai"],
  ["openrouter", "ai"],
  ["hf", "ai"],
  ["huggingface-papers", "ai"],
  ["replicate", "ai"],
  ["deepseek", "ai"],
  ["perplexity", "ai"],
  ["grok", "ai"],
  ["gemini", "ai"],
  ["minimax", "ai"],
  ["doubao", "ai"],
  ["doubao-web", "ai"],
  ["novita", "ai"],
  ["notebooklm", "ai"],

  // Reference / Education
  ["google", "reference"],
  ["wikipedia", "reference"],
  ["arxiv", "reference"],
  ["dictionary", "reference"],
  ["cnki", "reference"],
  ["chaoxing", "reference"],
  ["imdb", "reference"],
  ["paperreview", "reference"],

  // Music / Audio
  ["spotify", "audio"],
  ["netease-music", "audio"],
  ["apple-podcasts", "audio"],
  ["xiaoyuzhou", "audio"],

  // Media / Content
  ["medium", "content"],
  ["substack", "content"],
  ["sspai", "content"],
  ["weread", "content"],
  ["zsxq", "content"],
  ["pixiv", "content"],

  // Jobs
  ["boss", "jobs"],
  ["linkedin", "jobs"],

  // Desktop
  ["macos", "desktop"],
  ["ffmpeg", "desktop"],
  ["imagemagick", "desktop"],
  ["blender", "desktop"],
  ["gimp", "desktop"],
  ["freecad", "desktop"],
  ["inkscape", "desktop"],
  ["pandoc", "desktop"],
  ["libreoffice", "desktop"],
  ["mermaid", "desktop"],
  ["musescore", "desktop"],
  ["drawio", "desktop"],
  ["docker", "desktop"],
  ["comfyui", "desktop"],

  // Games
  ["steam", "games"],

  // Utility
  ["exchangerate", "utility"],
  ["ip-info", "utility"],
  ["qweather", "utility"],
  ["web", "utility"],
]);

// ── Category Aliases ────────────────────────────────────────────────────────
// Chinese category terms → canonical category names

export const CATEGORY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["社交", "social"],
  ["社区", "social"],
  ["视频", "video"],
  ["短视频", "video"],
  ["直播", "video"],
  ["新闻", "news"],
  ["资讯", "news"],
  ["金融", "finance"],
  ["财经", "finance"],
  ["股票", "finance"],
  ["购物", "shopping"],
  ["电商", "shopping"],
  ["开发", "dev"],
  ["开发者", "dev"],
  ["编程", "dev"],
  ["人工智能", "ai"],
  ["AI", "ai"],
  ["教育", "reference"],
  ["学术", "reference"],
  ["音乐", "audio"],
  ["音频", "audio"],
  ["求职", "jobs"],
  ["招聘", "jobs"],
  ["桌面", "desktop"],
  ["系统", "desktop"],
  ["游戏", "games"],
  ["工具", "utility"],
]);

// ── Query Expansion ─────────────────────────────────────────────────────────

/**
 * Expand a single query token using all alias tables.
 * Returns an array of canonical English terms.
 */
export function expandToken(token: string): string[] {
  const lower = token.toLowerCase();
  const results: string[] = [lower];

  // Site alias: if the token IS a site name alias, add the canonical site
  const siteMatch = SITE_ALIASES.get(token) ?? SITE_ALIASES.get(lower);
  if (siteMatch) results.push(siteMatch);

  // Action verb expansion
  const actionMatch = ACTION_ALIASES.get(token) ?? ACTION_ALIASES.get(lower);
  if (actionMatch) results.push(...actionMatch);

  // Domain term expansion
  const domainMatch = DOMAIN_ALIASES.get(token) ?? DOMAIN_ALIASES.get(lower);
  if (domainMatch) results.push(...domainMatch);

  // Deduplicate
  return [...new Set(results)];
}

// ── CJK Detection ──────────────────────────────────────────────────────────
// Covers all CJK Unified Ideographs blocks including supplementary planes
// (Extensions A–H) and CJK Compatibility Ideographs. Requires `u` flag for
// supplementary plane code points (\u{xxxxx}).

const CJK_REGEX =
  /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}\u{31350}-\u{323af}]/u;

/**
 * Test whether a single character is a CJK ideograph.
 * Handles supplementary plane characters (Extension B–H).
 */
export function isCJKChar(char: string): boolean {
  return CJK_REGEX.test(char);
}

// ── Stopwords ──────────────────────────────────────────────────────────────
// Minimal English stopword set — articles, prepositions, and other
// high-frequency, low-signal words that appear in descriptions.

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "and",
  "or",
  "in",
  "to",
  "on",
  "by",
  "is",
  "it",
  "be",
  "as",
  "at",
  "so",
  "we",
  "he",
  "do",
  "no",
  "if",
  "up",
  "my",
]);

/**
 * Tokenize a query string, handling both Chinese and English.
 *
 * Strategy: accumulate characters into segments by script type.
 * Chinese chars form contiguous phrases that get sub-phrase expanded.
 * English/Latin chars form words split by whitespace.
 */
export function tokenizeQuery(query: string): string[] {
  // NFKC normalization: full-width → half-width, compatibility decomposition
  query = query.normalize("NFKC");

  const segments: Array<{ text: string; isChinese: boolean }> = [];
  let current = "";
  let inChinese = false;

  for (const char of query) {
    const isCJK = isCJKChar(char);
    const isDelimiter = /[\s,;.!?，。！？、；：]/.test(char);

    if (isDelimiter) {
      // Flush current segment
      if (current) {
        segments.push({ text: current, isChinese: inChinese });
        current = "";
      }
      continue;
    }

    if (isCJK !== inChinese && current) {
      // Script switch — flush previous segment UNLESS the non-CJK part is
      // 1-2 chars (common in mixed brands: B站, QQ音乐, V2EX, 1688).
      // In that case, keep them merged.
      if (!inChinese && current.length <= 2 && isCJK) {
        // Short Latin prefix before Chinese — don't flush, keep merging
        inChinese = true;
        current += char;
        continue;
      }
      segments.push({ text: current, isChinese: inChinese });
      current = "";
    }

    current += char;
    inChinese = isCJK;
  }
  if (current) segments.push({ text: current, isChinese: inChinese });

  // Expand segments into tokens
  const tokens: string[] = [];
  for (const seg of segments) {
    if (seg.isChinese && seg.text.length > 1) {
      // Full phrase
      tokens.push(seg.text);
      // Sliding window: 2-char, 3-char, 4-char sub-phrases
      for (let len = 2; len <= Math.min(seg.text.length, 4); len++) {
        for (let i = 0; i <= seg.text.length - len; i++) {
          const sub = seg.text.slice(i, i + len);
          if (sub !== seg.text) tokens.push(sub);
        }
      }
    } else if (seg.isChinese) {
      // Single Chinese char — still useful for alias lookup
      tokens.push(seg.text);
    } else {
      // English: split on internal delimiters
      tokens.push(...seg.text.split(/[-_/]/).filter((w) => w.length > 0));
    }
  }

  return [...new Set(tokens)].filter(
    (t) => t.length > 0 && !STOPWORDS.has(t.toLowerCase()),
  );
}
