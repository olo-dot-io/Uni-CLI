/**
 * @owner   src/discovery/aliases.ts
 * @does    Define bilingual aliases, action synonyms, domain synonyms, site categories, and scholarly discovery vocabulary.
 * @needs   Supported site ids, discovery search scoring rules
 * @feeds   src/discovery/search.ts, src/registry.ts, generated manifest categories
 * @breaks  Missing aliases or categories degrade command discovery relevance.
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
  ["飞书", "lark"],
  ["钉钉", "dingtalk"],
  ["企业微信", "wechat-work"],
  ["网易云", "netease-music"],
  ["网易云音乐", "netease-music"],
  ["飞书桌面", "lark"],
  ["钉钉桌面", "dingtalk"],
  ["企微", "wechat-work"],
  ["企业微信桌面", "wechat-work"],
  ["微信工作台", "wechat-work"],
  ["腾讯会议", "zoom-app"],

  // Chinese finance
  ["雪球", "xueqiu"],
  ["东方财富", "eastmoney"],
  ["东财", "eastmoney"],
  ["新浪财经", "sinafinance"],
  ["富途", "futu"],
  ["币安", "binance"],
  ["同花顺", "ths"],
  ["通达信", "tdx"],

  // Chinese shopping
  ["淘宝", "taobao"],
  ["京东", "jd"],
  ["1688", "1688"],
  ["阿里巴巴", "1688"],
  ["前程无忧", "51job"],
  ["牛客", "nowcoder"],
  ["牛客网", "nowcoder"],
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
  ["小宇宙", "xiaoyuzhou"],
  ["幕布", "mubu"],
  ["夸克网盘", "quark"],
  ["夸克", "quark"],
  ["虎扑", "hupu"],
  ["知网", "cnki"],
  ["万方", "wanfang"],
  ["百度学术", "baidu-scholar"],
  ["谷歌学术", "google-scholar"],
  ["国家法律法规库", "gov-law"],
  ["政策文件库", "gov-policy"],
  ["剑鱼", "jianyu"],
  ["电建", "powerchina"],
  ["中国电建", "powerchina"],
  ["超星", "chaoxing"],

  // Chinese tech
  ["掘金", "juejin"],
  ["码云", "gitee"],
  ["VSCode", "vscode"],
  ["vscode", "vscode"],
  ["Cursor", "cursor"],
  ["cursor", "cursor"],
  ["Figma", "figma"],
  ["figma", "figma"],
  ["Postman", "postman"],
  ["postman", "postman"],
  ["Docker Desktop", "docker-desktop"],
  ["Microsoft Word", "word"],
  ["Word", "word"],
  ["word", "word"],
  ["微软Word", "word"],
  ["文档", "word"],
  ["Microsoft Excel", "excel"],
  ["Excel", "excel"],
  ["excel", "excel"],
  ["表格", "excel"],
  ["电子表格", "excel"],
  ["Microsoft PowerPoint", "powerpoint"],
  ["PowerPoint", "powerpoint"],
  ["powerpoint", "powerpoint"],
  ["PPT", "powerpoint"],
  ["ppt", "powerpoint"],
  ["幻灯片", "powerpoint"],
  ["互联网", "google"],
  ["网页搜索", "google"],
  ["P站", "pixiv"],
  ["p站", "pixiv"],
  ["pixiv", "pixiv"],
  ["Danbooru", "danbooru"],
  ["danbooru", "danbooru"],
  ["E-Hentai", "ehentai"],
  ["e-hentai", "ehentai"],
  ["ehentai", "ehentai"],
  ["exhentai", "ehentai"],
  ["DLsite", "dlsite"],
  ["dlsite", "dlsite"],
  ["萌娘百科", "moegirl"],
  ["萌百", "moegirl"],
  ["moegirl", "moegirl"],
  ["moegirlpedia", "moegirl"],
  ["AniList", "anilist"],
  ["anilist", "anilist"],
  ["MyAnimeList", "jikan"],
  ["myanimelist", "jikan"],
  ["MAL", "jikan"],
  ["mal", "jikan"],
  ["Jikan", "jikan"],
  ["jikan", "jikan"],
  ["Bangumi", "bangumi"],
  ["bangumi", "bangumi"],
  ["番组计划", "bangumi"],
  ["番組計劃", "bangumi"],
  ["アニリスト", "anilist"],
  ["マイアニメリスト", "jikan"],
  ["マル", "jikan"],
  ["Kitsu", "kitsu"],
  ["kitsu", "kitsu"],
  ["MangaDex", "mangadex"],
  ["mangadex", "mangadex"],
  ["Konachan", "konachan"],
  ["konachan", "konachan"],
  ["Safebooru", "safebooru"],
  ["safebooru", "safebooru"],
  ["vndb", "vndb"],
  ["视觉小说", "vndb"],
  ["galgame", "vndb"],
  ["yande.re", "yandere"],
  ["yandere", "yandere"],
  ["yande", "yandere"],

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
  ["豆包桌面", "doubao-app"],
  ["ChatGPT桌面", "chatgpt"],
  ["Claude桌面", "claude"],
  ["Claude", "claude"],
  ["LM Studio", "lm-studio"],
  ["通义千问", "qwen"],

  // Desktop
  ["Notion", "notion"],
  ["notion", "notion"],
  ["Obsidian", "obsidian"],
  ["obsidian", "obsidian"],
  ["印象笔记", "evernote-app"],
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
  ["换字体", ["set-font", "font", "format"]],
  ["字体", ["set-font", "font", "format"]],
  ["设置字体", ["set-font", "font", "format"]],
  ["修改字体", ["set-font", "font", "format"]],
  ["font", ["set-font", "font", "format"]],
  ["插入图片", ["insert-image", "image", "picture"]],
  ["插入链接", ["insert-link", "link", "hyperlink"]],

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
  ["打开", ["open", "launch"]],
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
  ["修改", ["edit", "set", "insert", "add", "update"]],
  ["编辑", ["edit", "set", "insert", "add", "update"]],
  ["写入", ["write", "set", "insert"]],
  ["插入", ["insert", "add", "create"]],
  ["添加", ["add", "insert", "create"]],
  ["加", ["add", "insert", "create"]],
  ["加一页", ["add-slide", "add", "slide", "create"]],
  ["加页", ["add-slide", "add", "slide", "create"]],
  ["新增一页", ["add-slide", "add", "slide", "create"]],
  ["新增页面", ["add-slide", "add", "slide", "create"]],
  ["改", ["edit", "set", "add", "update"]],
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
  [
    "作者",
    ["author", "authors", "creator", "creators", "artist", "artists", "staff"],
  ],
  [
    "画师",
    ["artist", "artists", "creator", "creators", "author", "authors", "staff"],
  ],
  ["漫画家", ["mangaka", "author", "authors", "artist", "artists", "staff"]],
  ["作家", ["author", "authors", "creator", "creators", "staff"]],
  [
    "原画",
    ["artist", "artists", "illustrator", "creator", "creators", "staff"],
  ],
  [
    "author",
    [
      "author",
      "authors",
      "creator",
      "creators",
      "artist",
      "artists",
      "staff",
      "people",
    ],
  ],
  [
    "artist",
    ["artist", "artists", "creator", "creators", "author", "authors", "staff"],
  ],
  [
    "creator",
    [
      "creator",
      "creators",
      "author",
      "authors",
      "artist",
      "artists",
      "staff",
      "people",
    ],
  ],

  // Info / Detail intent
  ["详情", ["detail", "info", "get"]],
  ["信息", ["info", "detail", "about"]],
  ["detail", ["detail", "info", "get"]],

  // Play / Media intent
  ["播放", ["play", "stream"]],
  ["收听", ["play", "listen"]],
  ["我喜欢", ["play-liked", "liked", "favorite", "music"]],
  ["喜欢的音乐", ["play-liked", "liked", "favorite", "music"]],
  ["红心", ["play-liked", "liked", "favorite", "music"]],
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
  ["行情", ["ticker", "price", "quote"]],
  ["成交", ["trades", "trade", "volume"]],
  ["最新成交", ["trades", "trade"]],
  ["深度", ["depth", "orderbook", "book"]],
  ["挂单", ["depth", "asks", "bids", "orderbook"]],
  ["卖盘", ["asks", "ask", "depth"]],
  ["买盘", ["depth", "bid", "bids"]],
  ["涨幅", ["gainers", "gain", "top"]],
  ["跌幅", ["losers", "loss", "bottom"]],
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
  [
    "论文",
    [
      "paper",
      "papers",
      "academic",
      "research",
      "scholar",
      "scholarly",
      "publication",
      "literature",
    ],
  ],
  ["学术", ["academic", "research", "scholar", "scholarly", "paper", "papers"]],
  [
    "文献",
    [
      "literature",
      "publication",
      "paper",
      "papers",
      "bibliography",
      "research",
    ],
  ],
  ["引用", ["citation", "citations", "reference", "references"]],
  ["参考文献", ["reference", "references", "citation", "citations"]],
  ["期刊", ["journal", "publication", "paper", "papers"]],
  ["会议论文", ["conference", "paper", "papers", "proceedings"]],
  ["课程", ["course", "class", "lesson"]],
  ["paper", ["paper", "papers", "thesis", "research", "academic"]],
  ["papers", ["papers", "paper", "research", "academic", "scholarly"]],
  [
    "academic",
    ["academic", "research", "scholar", "scholarly", "paper", "papers"],
  ],
  ["scholar", ["scholar", "scholarly", "academic", "research", "paper"]],
  ["scholarly", ["scholarly", "academic", "research", "paper", "papers"]],
  ["literature", ["literature", "publication", "paper", "papers", "research"]],
  ["publication", ["publication", "paper", "papers", "research"]],
  ["bibliography", ["bibliography", "citation", "references", "dblp"]],
  ["citation", ["citation", "citations", "reference", "references"]],
  ["doi", ["doi", "paper", "publication"]],
  ["semantic scholar", ["semantic", "scholar", "paper", "citation"]],
  ["semanticscholar", ["semantic", "scholar", "paper", "citation"]],
  ["crossref", ["crossref", "doi", "publication", "metadata"]],
  ["unpaywall", ["unpaywall", "open", "access", "pdf"]],
  ["conference", ["conference", "proceedings", "paper", "papers"]],
  ["proceedings", ["proceedings", "conference", "paper", "papers", "venue"]],
  ["pmlr", ["pmlr", "proceedings", "conference", "paper", "papers", "venue"]],
  ["icml", ["icml", "pmlr", "conference", "paper", "papers"]],
  ["neurips", ["neurips", "nips", "conference", "paper", "papers"]],
  ["nips", ["neurips", "nips", "conference", "paper", "papers"]],
  ["iclr", ["iclr", "openreview", "conference", "paper", "papers"]],
  ["cvpr", ["cvpr", "conference", "computer", "vision", "paper", "papers"]],
  ["cvf", ["cvf", "cvpr", "iccv", "eccv", "computer", "vision", "paper"]],
  ["iccv", ["iccv", "conference", "computer", "vision", "paper", "papers"]],
  ["eccv", ["eccv", "conference", "computer", "vision", "paper", "papers"]],
  ["acl", ["acl", "anthology", "conference", "paper", "papers"]],
  ["anthology", ["acl", "anthology", "conference", "paper", "papers"]],
  ["emnlp", ["emnlp", "acl", "anthology", "conference", "paper", "papers"]],
  ["naacl", ["naacl", "acl", "anthology", "conference", "paper", "papers"]],
  ["kdd", ["kdd", "conference", "paper", "papers"]],
  ["sigir", ["sigir", "conference", "paper", "papers"]],
  ["www", ["www", "web", "conference", "paper", "papers"]],
  ["vldb", ["vldb", "database", "conference", "paper", "papers"]],
  ["sigmod", ["sigmod", "database", "conference", "paper", "papers"]],
  [
    "icse",
    ["icse", "software", "engineering", "conference", "paper", "papers"],
  ],
  ["fse", ["fse", "software", "engineering", "conference", "paper", "papers"]],
  ["ase", ["ase", "software", "engineering", "conference", "paper", "papers"]],
  [
    "pldi",
    ["pldi", "programming", "language", "conference", "paper", "papers"],
  ],
  ["experiment", ["experiment", "experiments", "method", "results", "paper"]],
  ["experiments", ["experiments", "experiment", "method", "results", "paper"]],
  ["method", ["method", "methods", "experiment", "paper"]],
  ["methods", ["methods", "method", "experiment", "paper"]],
  ["results", ["results", "experiment", "conclusion", "paper"]],
  ["conclusion", ["conclusion", "results", "paper"]],
  ["research", ["research", "paper", "papers", "academic", "scholarly"]],

  // Entertainment
  ["电影", ["movie", "film", "cinema", "hot", "maoyan"]],
  ["电视剧", ["drama", "tv", "series"]],
  ["游戏", ["game", "gaming", "steam"]],
  ["动漫", ["anime", "manga", "bangumi"]],
  ["二次元", ["acg", "anime", "manga", "character", "wiki", "moegirl"]],
  ["acg", ["acg", "anime", "manga", "character", "wiki", "moegirl"]],
  ["漫画", ["manga", "comic", "mangadex", "jikan", "anilist", "bangumi"]],
  ["マンガ", ["manga", "comic", "mangadex", "jikan", "anilist", "bangumi"]],
  ["本子", ["doujin", "manga", "tag", "ehentai", "danbooru", "dlsite"]],
  ["同人誌", ["doujin", "manga", "tag", "ehentai", "danbooru", "dlsite"]],
  ["CG集", ["cg", "illustration", "dlsite", "pixiv", "danbooru"]],
  ["cg集", ["cg", "illustration", "dlsite", "pixiv", "danbooru"]],
  [
    "美少女ゲーム",
    ["bishoujo", "galgame", "visual", "novel", "vndb", "dlsite", "bangumi"],
  ],
  [
    "美少女游戏",
    ["bishoujo", "galgame", "visual", "novel", "vndb", "dlsite", "bangumi"],
  ],
  ["ギャルゲー", ["galgame", "visual", "novel", "vndb", "dlsite", "bangumi"]],
  ["エロゲ", ["eroge", "galgame", "visual", "novel", "vndb", "dlsite"]],
  ["成人向け", ["adult", "doujin", "dlsite", "ehentai", "tag"]],
  [
    "イラスト",
    [
      "illustration",
      "image",
      "pixiv",
      "danbooru",
      "yandere",
      "konachan",
      "safebooru",
    ],
  ],
  [
    "画像",
    [
      "image",
      "illustration",
      "pixiv",
      "danbooru",
      "yandere",
      "konachan",
      "safebooru",
    ],
  ],
  [
    "タグ",
    ["tag", "tags", "danbooru", "yandere", "konachan", "safebooru", "ehentai"],
  ],
  [
    "booru",
    ["booru", "tag", "tags", "danbooru", "yandere", "konachan", "safebooru"],
  ],
  ["日文", ["japanese", "native", "romaji", "anime", "manga", "acg"]],
  ["日本語", ["japanese", "native", "romaji", "anime", "manga", "acg"]],
  ["罗马音", ["romaji", "romanized", "alias", "japanese", "native"]],
  ["羅馬音", ["romaji", "romanized", "alias", "japanese", "native"]],
  ["ローマ字", ["romaji", "romanized", "alias", "japanese", "native"]],
  ["romaji", ["romaji", "romanized", "alias", "japanese", "native"]],
  ["角色", ["character", "wiki", "moegirl", "pixiv", "danbooru", "yandere"]],
  [
    "同人",
    ["doujin", "tag", "pixiv", "danbooru", "yandere", "ehentai", "dlsite"],
  ],
  [
    "花火",
    [
      "sparkle",
      "hanabi",
      "honkai",
      "star",
      "rail",
      "character",
      "wiki",
      "moegirl",
      "anilist",
      "jikan",
      "bangumi",
      "kitsu",
      "pixiv",
      "danbooru",
      "yandere",
      "tag",
    ],
  ],
  [
    "hanabi",
    [
      "花火",
      "sparkle",
      "honkai",
      "star",
      "rail",
      "character",
      "wiki",
      "moegirl",
      "anilist",
      "jikan",
      "bangumi",
      "kitsu",
      "mangadex",
      "pixiv",
      "danbooru",
      "yandere",
      "konachan",
      "tag",
    ],
  ],
  [
    "ブルーアーカイブ",
    [
      "blue",
      "archive",
      "blue_archive",
      "game",
      "character",
      "tag",
      "tags",
      "illustration",
      "pixiv",
      "danbooru",
      "yandere",
      "konachan",
      "safebooru",
      "wiki",
    ],
  ],
  [
    "blue_archive",
    [
      "blue",
      "archive",
      "ブルーアーカイブ",
      "game",
      "character",
      "tag",
      "tags",
      "illustration",
      "pixiv",
      "danbooru",
      "yandere",
      "konachan",
      "safebooru",
      "wiki",
    ],
  ],
  [
    "学園アイドルマスター",
    [
      "gakuen",
      "idolmaster",
      "gakumas",
      "game",
      "character",
      "bangumi",
      "wiki",
      "anilist",
      "jikan",
      "pixiv",
      "danbooru",
    ],
  ],
  [
    "学マス",
    [
      "gakuen",
      "idolmaster",
      "gakumas",
      "game",
      "character",
      "bangumi",
      "wiki",
      "pixiv",
      "danbooru",
    ],
  ],
  [
    "gakumas",
    [
      "学園アイドルマスター",
      "gakuen",
      "idolmaster",
      "game",
      "character",
      "bangumi",
      "wiki",
      "pixiv",
      "danbooru",
    ],
  ],
  [
    "sparkle",
    [
      "花火",
      "hanabi",
      "honkai",
      "star",
      "rail",
      "character",
      "wiki",
      "moegirl",
      "anilist",
      "jikan",
      "bangumi",
      "kitsu",
      "pixiv",
      "danbooru",
      "yandere",
      "tag",
    ],
  ],
  [
    "スパークル",
    [
      "花火",
      "hanabi",
      "sparkle",
      "honkai",
      "star",
      "rail",
      "character",
      "wiki",
      "moegirl",
      "anilist",
      "jikan",
      "bangumi",
      "pixiv",
      "danbooru",
      "yandere",
      "tag",
    ],
  ],
  [
    "星穹铁道",
    [
      "honkai",
      "star",
      "rail",
      "character",
      "wiki",
      "moegirl",
      "bangumi",
      "anilist",
      "jikan",
      "pixiv",
      "danbooru",
      "yandere",
      "bilibili",
    ],
  ],
  [
    "崩坏星穹铁道",
    [
      "honkai",
      "star",
      "rail",
      "character",
      "wiki",
      "moegirl",
      "bangumi",
      "anilist",
      "jikan",
      "pixiv",
      "danbooru",
      "yandere",
      "bilibili",
    ],
  ],
  [
    "崩壊スターレイル",
    [
      "honkai",
      "star",
      "rail",
      "character",
      "wiki",
      "moegirl",
      "bangumi",
      "anilist",
      "jikan",
      "pixiv",
      "danbooru",
      "yandere",
      "bilibili",
    ],
  ],
  [
    "スターレイル",
    [
      "honkai",
      "star",
      "rail",
      "character",
      "wiki",
      "moegirl",
      "bangumi",
      "anilist",
      "jikan",
      "pixiv",
      "danbooru",
      "yandere",
      "bilibili",
    ],
  ],
  [
    "柚子社",
    [
      "yuzusoft",
      "visual",
      "novel",
      "producer",
      "producers",
      "studio",
      "studios",
      "vndb",
      "bangumi",
      "mangadex",
      "moegirl",
      "wiki",
    ],
  ],
  [
    "ゆずソフト",
    [
      "yuzusoft",
      "柚子社",
      "visual",
      "novel",
      "producer",
      "producers",
      "studio",
      "studios",
      "vndb",
      "bangumi",
      "mangadex",
      "moegirl",
      "wiki",
    ],
  ],
  [
    "yuzusoft",
    [
      "yuzusoft",
      "visual",
      "novel",
      "producer",
      "producers",
      "studio",
      "studios",
      "vndb",
      "bangumi",
      "mangadex",
      "moegirl",
      "wiki",
    ],
  ],
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
  ["slack", "social"],
  ["discord-app", "social"],
  ["signal", "social"],
  ["whatsapp", "social"],
  ["teams", "social"],
  ["dingtalk", "social"],
  ["lark", "social"],
  ["feishu", "social"],
  ["wechat-work", "social"],
  ["weixin", "social"],
  ["threads", "social"],
  ["rednote", "social"],
  ["1point3acres", "social"],
  ["imessage", "social"],
  ["zoom-app", "social"],
  ["zoom", "social"],

  // Video / Streaming
  ["bilibili", "video"],
  ["youtube", "video"],
  ["douyin", "video"],
  ["tiktok", "video"],
  ["twitch", "video"],
  ["kuaishou", "video"],
  ["douyu", "video"],
  ["yt-dlp", "video"],

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
  ["coingecko", "finance"],
  ["defillama", "finance"],

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
  ["maven", "dev"],
  ["nuget", "dev"],
  ["rubygems", "dev"],
  ["packagist", "dev"],
  ["pub-dev", "dev"],
  ["cocoapods", "dev"],
  ["docker-hub", "dev"],
  ["npm-trends", "dev"],
  ["homebrew", "dev"],
  ["stackoverflow", "dev"],
  ["devto", "dev"],
  ["producthunt", "dev"],
  ["cursor", "dev"],
  ["codex", "dev"],
  ["codex-cli", "dev"],
  ["claude-code", "dev"],
  ["opencode", "dev"],
  ["vscode", "dev"],
  ["postman", "dev"],
  ["insomnia", "dev"],
  ["github-desktop", "dev"],
  ["gitkraken", "dev"],
  ["docker-desktop", "dev"],
  ["gh", "dev"],
  ["crates", "dev"],
  ["dockerhub", "dev"],
  ["goproxy", "dev"],
  ["wiremock", "dev"],
  ["juejin", "dev"],
  ["osv", "dev"],
  ["openharness", "dev"],
  ["agents", "agent"],
  ["mcp", "agent"],
  ["runs", "agent"],

  // AI
  ["ollama", "ai"],
  ["openrouter", "ai"],
  ["hf", "ai"],
  ["replicate", "ai"],
  ["deepseek", "ai"],
  ["perplexity", "ai"],
  ["grok", "ai"],
  ["gemini", "ai"],
  ["minimax", "ai"],
  ["doubao", "ai"],
  ["doubao-web", "ai"],
  ["doubao-app", "ai"],
  ["novita", "ai"],
  ["notebooklm", "ai"],
  ["chatgpt", "ai"],
  ["chatwise", "ai"],
  ["antigravity", "ai"],
  ["claude", "ai"],
  ["lm-studio", "ai"],
  ["yuanbao", "ai"],
  ["qwen", "ai"],
  ["chatgpt-app", "ai"],
  ["yollomi", "ai"],
  ["jimeng", "ai"],

  // Scholarly / Academic
  ["arxiv", "scholarly"],
  ["semantic-scholar", "scholarly"],
  ["crossref", "scholarly"],
  ["unpaywall", "scholarly"],
  ["openalex", "scholarly"],
  ["openreview", "scholarly"],
  ["dblp", "scholarly"],
  ["pubmed", "scholarly"],
  ["acl-anthology", "scholarly"],
  ["pmlr", "scholarly"],
  ["cvf", "scholarly"],
  ["neurips", "scholarly"],
  ["cnki", "scholarly"],
  ["wanfang", "scholarly"],
  ["google-scholar", "scholarly"],
  ["baidu-scholar", "scholarly"],
  ["huggingface-papers", "scholarly"],
  ["paperreview", "scholarly"],
  ["zotero", "scholarly"],

  // Patent / IP
  ["epo", "patent"],
  ["espacenet", "patent"],
  ["cipo", "patent"],
  ["cnipa", "patent"],
  ["uspto", "patent"],
  ["dpma", "patent"],
  ["fips", "patent"],
  ["freepatentsonline-web", "patent"],
  ["google-patents-bq", "patent"],
  ["google-patents-web", "patent"],
  ["inpi-br", "patent"],
  ["inpi-fr", "patent"],
  ["ipaustralia", "patent"],
  ["jpo", "patent"],
  ["kipris", "patent"],
  ["patsnap", "patent"],
  ["pqai", "patent"],

  // Reference / Education
  ["google", "reference"],
  ["wikipedia", "reference"],
  ["moegirl", "reference"],
  ["anilist", "reference"],
  ["jikan", "reference"],
  ["bangumi", "reference"],
  ["kitsu", "reference"],
  ["mangadex", "reference"],
  ["dictionary", "reference"],
  ["chaoxing", "reference"],
  ["imdb", "reference"],

  // Music / Audio
  ["spotify", "audio"],
  ["netease-music", "audio"],
  ["apple-podcasts", "audio"],
  ["xiaoyuzhou", "audio"],

  // Media / Content
  ["medium", "content"],
  ["substack", "content"],
  ["lesswrong", "content"],
  ["sinablog", "content"],
  ["toutiao", "content"],
  ["sspai", "content"],
  ["weread", "content"],
  ["zsxq", "content"],
  ["pixiv", "content"],
  ["danbooru", "content"],
  ["ehentai", "content"],
  ["dlsite", "content"],
  ["vndb", "content"],
  ["yandere", "content"],
  ["konachan", "content"],
  ["safebooru", "content"],

  // Productivity
  ["notion", "productivity"],
  ["notion-app", "productivity"],
  ["obsidian", "productivity"],
  ["logseq", "productivity"],
  ["typora", "productivity"],
  ["evernote-app", "productivity"],
  ["mubu", "productivity"],
  ["apple-notes", "productivity"],
  ["ones", "productivity"],
  ["quark", "productivity"],

  // Jobs
  ["boss", "jobs"],
  ["linkedin", "jobs"],
  ["nowcoder", "jobs"],
  ["51job", "jobs"],
  ["indeed", "jobs"],
  ["maimai", "jobs"],

  // Desktop
  ["macos", "desktop"],
  ["browser", "browser"],
  ["operate", "browser"],
  ["ffmpeg", "desktop"],
  ["imagemagick", "desktop"],
  ["blender", "desktop"],
  ["gimp", "desktop"],
  ["freecad", "desktop"],
  ["inkscape", "desktop"],
  ["pandoc", "desktop"],
  ["libreoffice", "desktop"],
  ["word", "desktop"],
  ["excel", "desktop"],
  ["powerpoint", "desktop"],
  ["mermaid", "desktop"],
  ["musescore", "desktop"],
  ["drawio", "desktop"],
  ["docker", "desktop"],
  ["comfyui", "desktop"],
  ["figma", "desktop"],
  ["audacity", "desktop"],
  ["obs", "desktop"],
  ["cloudcompare", "desktop"],
  ["krita", "desktop"],
  ["kdenlive", "desktop"],
  ["shotcut", "desktop"],
  ["renderdoc", "desktop"],

  // Games
  ["steam", "games"],

  // Utility
  ["exchangerate", "utility"],
  ["ip-info", "utility"],
  ["qweather", "utility"],
  ["web", "utility"],
  ["bitwarden", "utility"],
  ["linear", "utility"],
  ["todoist", "utility"],
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
  ["学术", "scholarly"],
  ["论文", "scholarly"],
  ["文献", "scholarly"],
  ["引用", "scholarly"],
  ["期刊", "scholarly"],
  ["academic", "scholarly"],
  ["scholar", "scholarly"],
  ["scholarly", "scholarly"],
  ["research", "scholarly"],
  ["paper", "scholarly"],
  ["papers", "scholarly"],
  ["literature", "scholarly"],
  ["publication", "scholarly"],
  ["bibliography", "scholarly"],
  ["citation", "scholarly"],
  ["doi", "scholarly"],
  ["conference", "scholarly"],
  ["专利", "patent"],
  ["知识产权", "patent"],
  ["patent", "patent"],
  ["patents", "patent"],
  ["音乐", "audio"],
  ["音频", "audio"],
  ["求职", "jobs"],
  ["招聘", "jobs"],
  ["桌面", "desktop"],
  ["系统", "desktop"],
  ["效率", "productivity"],
  ["生产力", "productivity"],
  ["笔记", "productivity"],
  ["游戏", "games"],
  ["二次元", "content"],
  ["ACG", "content"],
  ["acg", "content"],
  ["同人", "content"],
  ["工具", "utility"],
  ["浏览器", "browser"],
  ["网页自动化", "browser"],
  ["自动化", "browser"],
  ["browser", "browser"],
  ["automation", "browser"],
  ["agent", "agent"],
  ["agents", "agent"],
  ["mcp", "agent"],
  ["trace", "agent"],
  ["evidence", "agent"],
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
// Covers CJK Unified Ideographs plus Japanese Hiragana/Katakana so mixed
// Chinese/Japanese ACG queries keep useful tokens for alias expansion.

const CJK_REGEX =
  /[\u3040-\u30ff\u31f0-\u31ff\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}\u{31350}-\u{323af}]/u;

/**
 * Test whether a single character is useful for CJK/Japanese query grouping.
 * Handles supplementary CJK planes plus kana.
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
