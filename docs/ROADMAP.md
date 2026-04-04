# Uni-CLI Roadmap — Mission Vostok (0.2xx)

> CLI is all agents need. Uni-CLI is the entry point for AI agents to touch, sense, understand, modify, and control any internet application and local software.

## Philosophy

We are not a scraper. We are not a CLI tool. We are **agent infrastructure**.

The insight: CLI is a stable execution layer — a cache for agent behaviors. Stable single operations compose into long-chain workflows. Our differentiator is not breadth (adapter count) but **self-sufficiency** — agents can write, fix, and verify their own tools.

The core problem: when a CLI adapter breaks (API changes, selector drifts, auth rotates), traditional tools require human intervention — file a bug, wait for a fix, update the package. Uni-CLI closes this loop: the agent reads the 20-line YAML, edits it, verifies the fix, and moves on.

### Self-Healing Architecture

```
unicli <site> <command>
  → Fails (HTTP 403 / empty result / selector miss)
  → Structured error JSON:
    {
      "error": "HTTP 403",
      "adapter": "src/adapters/hackernews/top.yaml",
      "step": 0,
      "action": "fetch",
      "url": "https://...",
      "suggestion": "API endpoint changed. Edit the adapter YAML."
    }
  → AI reads 20-line YAML (fits in any context window)
  → AI edits YAML → re-runs → fixed
  → Fix lives in ~/.unicli/adapters/ (survives npm update)
```

---

## Complete Adapter Inventory

### Web Adapters (73 sites)

#### Tier 1: Public API (no browser needed) — 25 sites

| #   | Site            | Commands                                                                                                                            | Status       |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | hackernews      | top, search, best, new, show, ask, jobs, user                                                                                       | ✅ 2/8 done  |
| 2   | reddit          | hot, search, frontpage, popular, subreddit, user, read, comment, save, saved, subscribe, upvote, upvoted, user-comments, user-posts | ✅ 2/15 done |
| 3   | github-trending | daily                                                                                                                               | ✅ done      |
| 4   | lobsters        | hot, active, newest, tag                                                                                                            | pending      |
| 5   | stackoverflow   | hot, search, bounties, unanswered                                                                                                   | pending      |
| 6   | bbc             | news                                                                                                                                | pending      |
| 7   | wikipedia       | search, summary, random, trending                                                                                                   | pending      |
| 8   | apple-podcasts  | top, search, episodes                                                                                                               | pending      |
| 9   | arxiv           | search, paper                                                                                                                       | pending      |
| 10  | devto           | top, tag, user                                                                                                                      | pending      |
| 11  | hf              | top                                                                                                                                 | pending      |
| 12  | imdb            | search, title, person, reviews, top, trending                                                                                       | pending      |
| 13  | bluesky         | trending, search, profile, feeds, thread, user, followers, following, starter-packs                                                 | pending      |
| 14  | ctrip           | search                                                                                                                              | pending      |
| 15  | dictionary      | search, examples, synonyms                                                                                                          | pending      |
| 16  | google          | search, news, suggest, trends                                                                                                       | pending      |
| 17  | spotify         | status, play, pause, next, prev, volume, search, queue, shuffle, repeat, auth                                                       | pending      |
| 18  | steam           | top-sellers                                                                                                                         | pending      |
| 19  | sinafinance     | news, stock, rolling-news                                                                                                           | pending      |
| 20  | xiaoyuzhou      | episode, podcast, podcast-episodes                                                                                                  | pending      |
| 21  | bloomberg       | news, markets, tech, politics, economics, opinions, industries, main, feeds, businessweek                                           | pending      |
| 22  | v2ex            | hot, latest, topic, member, node, nodes, replies, user, daily, me, notifications                                                    | pending      |
| 23  | paperreview     | review, feedback, submit                                                                                                            | pending      |
| 24  | chatgpt         | ask, model, new, read, send, status                                                                                                 | pending      |
| 25  | web             | read                                                                                                                                | pending      |

#### Tier 2: Cookie Strategy (browser extension needed) — 40 sites

| #   | Site          | Cmds | Description                              |
| --- | ------------- | ---- | ---------------------------------------- |
| 26  | bilibili      | 13   | 视频、搜索、下载、评论、动态、历史、收藏 |
| 27  | twitter       | 26   | 推文、搜索、时间线、书签、关注、屏蔽、DM |
| 28  | xiaohongshu   | 13   | 笔记、搜索、下载、创作者数据             |
| 29  | douyin        | 13   | 视频、草稿、发布、数据分析               |
| 30  | weibo         | 7    | 微博、搜索、热搜                         |
| 31  | zhihu         | 4    | 热榜、搜索、问答、下载                   |
| 32  | douban        | 9    | 电影、图书、评分、Top250                 |
| 33  | instagram     | 15   | 帖子、关注、下载、探索                   |
| 34  | tiktok        | 15   | 视频、关注、探索、直播                   |
| 35  | facebook      | 10   | 动态、好友、群组、事件                   |
| 36  | amazon        | 5    | 搜索、商品、畅销、评论                   |
| 37  | youtube       | 5    | 搜索、视频、评论、字幕、频道             |
| 38  | linkedin      | 2    | 搜索、时间线                             |
| 39  | weread        | 7    | 书架、笔记、高亮、排行                   |
| 40  | jike          | 10   | 动态、评论、点赞、搜索                   |
| 41  | medium        | 3    | 文章、搜索、用户                         |
| 42  | substack      | 3    | Newsletter、搜索                         |
| 43  | boss          | 14   | 搜索、推荐、聊天、简历                   |
| 44  | xueqiu        | 10   | 行情、热门、基金、自选                   |
| 45  | pixiv         | 6    | 插画、搜索、排行、下载                   |
| 46  | linux-do      | 10   | 话题、搜索、用户                         |
| 47  | coupang       | 2    | 搜索、加购物车                           |
| 48  | tieba         | 4    | 热门、搜索、帖子                         |
| 49  | smzdm         | 1    | 搜索好价                                 |
| 50  | reuters       | 1    | 新闻搜索                                 |
| 51  | sinablog      | 4    | 文章、热门、搜索                         |
| 52  | band          | 4    | 群组、帖子、@提及                        |
| 53  | barchart      | 4    | 行情、期权、Greeks                       |
| 54  | chaoxing      | 2    | 作业、考试                               |
| 55  | jd            | 1    | 商品详情                                 |
| 56  | yahoo-finance | 1    | 行情                                     |
| 57  | ones          | 8    | 项目管理、任务、工时                     |
| 58  | zsxq          | 5    | 星球、话题、搜索                         |
| 59  | 36kr          | 4    | 文章、热榜、搜索                         |
| 60  | producthunt   | 4    | 热门、分类、今日                         |
| 61  | weixin        | 1    | 公众号文章下载                           |
| 62  | notebooklm    | 13   | 笔记本、来源、摘要                       |
| 63  | doubao        | 9    | 对话、会议纪要                           |
| 64  | gemini        | 3    | 对话、图片生成                           |
| 65  | grok          | 1    | 对话                                     |

#### Tier 3: Intercept Strategy — 4 sites (partial)

| #   | Site        | Commands                                                |
| --- | ----------- | ------------------------------------------------------- |
| —   | 36kr        | article, hot (intercept)                                |
| —   | xiaohongshu | feed, notifications (intercept)                         |
| —   | twitter     | followers, following, notifications, search (intercept) |
| —   | producthunt | browse, hot (intercept)                                 |

#### Tier 4: UI Strategy (Electron app control) — 8 sites

| #   | Site        | Cmds | Target App         |
| --- | ----------- | ---- | ------------------ |
| 66  | cursor      | 8    | Cursor IDE         |
| 67  | codex       | 7    | Codex Desktop      |
| 68  | chatwise    | 6    | ChatWise           |
| 69  | antigravity | 8    | Antigravity Ultra  |
| 70  | notion      | 8    | Notion Desktop     |
| 71  | discord-app | 7    | Discord Desktop    |
| 72  | doubao-app  | 7    | Doubao Desktop     |
| 73  | yollomi     | 12   | Yollomi (AI image) |
| 74  | jimeng      | 2    | 即梦AI             |

#### External CLI Bridge — 7 tools

| #   | CLI       | Auto-install        | Description    |
| --- | --------- | ------------------- | -------------- |
| 75  | gh        | brew install gh     | GitHub CLI     |
| 76  | docker    | brew install docker | Docker         |
| 77  | obsidian  | auto                | Obsidian vault |
| 78  | vercel    | npm i -g vercel     | Vercel deploy  |
| 79  | lark-cli  | auto                | 飞书/Lark      |
| 80  | wecom-cli | auto                | 企业微信       |
| 81  | dws       | auto                | 钉钉工作空间   |

### Desktop Adapters (32 software)

| #   | Software          | Category       | Backend                       | Requires        |
| --- | ----------------- | -------------- | ----------------------------- | --------------- |
| 82  | blender           | 3d             | blender --background --python | blender >= 4.2  |
| 83  | freecad           | 3d/CAD         | FreeCAD CLI (258 commands)    | FreeCAD >= 1.1  |
| 84  | cloudcompare      | 3d/point-cloud | cloudcompare CLI              | cloudcompare    |
| 85  | renderdoc         | graphics       | renderdoc Python bindings     | renderdoc       |
| 86  | gimp              | image          | gimp -i -b (batch)            | gimp            |
| 87  | inkscape          | image/svg      | inkscape --export-filename    | inkscape        |
| 88  | krita             | image/paint    | Krita CLI export              | krita           |
| 89  | sketch            | design         | sketch-constructor (Node.js)  | Node.js >= 16   |
| 90  | kdenlive          | video          | melt                          | melt            |
| 91  | shotcut           | video          | melt/ffmpeg                   | melt, ffmpeg    |
| 92  | videocaptioner    | video/subtitle | videocaptioner + ffmpeg       | pip, ffmpeg     |
| 93  | audacity          | audio          | sox                           | sox             |
| 94  | musescore         | music          | MuseScore 4 CLI               | musescore       |
| 95  | obs-studio        | streaming      | OBS CLI                       | obs-studio      |
| 96  | libreoffice       | office         | libreoffice --headless        | libreoffice     |
| 97  | zotero            | office/ref     | Zotero SQLite + Local API     | zotero          |
| 98  | mubu              | office/outline | Mubu desktop data             | mubu            |
| 99  | drawio            | diagrams       | draw.io desktop CLI           | draw.io         |
| 100 | mermaid           | diagrams       | mermaid-cli                   | npm mermaid-cli |
| 101 | ollama            | ai/llm         | REST API :11434               | ollama          |
| 102 | comfyui           | ai/image       | REST API :8188                | comfyui         |
| 103 | novita            | ai/cloud       | REST API (cloud)              | NOVITA_API_KEY  |
| 104 | notebooklm        | ai/research    | notebooklm-py CLI             | pip, login      |
| 105 | iterm2            | devops         | iTerm2 Python API             | iTerm2 (macOS)  |
| 106 | zoom              | communication  | Zoom REST API (OAuth2)        | zoom, oauth     |
| 107 | wiremock          | testing        | WireMock REST API             | java, wiremock  |
| 108 | adguardhome       | network        | AdGuardHome REST API          | adguardhome     |
| 109 | rms               | network/iot    | Teltonika RMS REST API        | RMS_API_TOKEN   |
| 110 | slay_the_spire_ii | game           | STS2_Bridge HTTP API          | game + mod      |
| 111 | intelwatch        | osint          | Node.js CLI                   | Node.js >= 18   |
| 112 | clibrowser        | web            | Rust binary                   | cargo / binary  |
| 113 | browser           | web            | DOMShell MCP                  | Node.js, Chrome |
| 114 | anygen            | generation     | AnyGen cloud API              | ANYGEN_API_KEY  |

### Additional Tools

| #   | Software         | Category | Type    | Why                                     |
| --- | ---------------- | -------- | ------- | --------------------------------------- |
| 115 | ffmpeg           | media    | desktop | ✅ done. Universal media tool.          |
| 116 | imagemagick      | image    | desktop | Image convert/transform/compose         |
| 117 | pandoc           | document | desktop | Universal document converter            |
| 118 | yt-dlp           | media    | bridge  | Video/audio downloader from 1000+ sites |
| 119 | sqlite3          | database | desktop | Local database queries                  |
| 120 | jq               | data     | bridge  | JSON processor                          |
| 121 | ripgrep          | search   | bridge  | Fast code search                        |
| 122 | wget/curl        | web      | bridge  | HTTP toolkit                            |
| 123 | magick           | image    | desktop | ImageMagick 7 CLI                       |
| 124 | tesseract        | ocr      | desktop | OCR text extraction                     |
| 125 | whisper          | audio/ai | desktop | Speech-to-text (local)                  |
| 126 | stable-diffusion | ai/image | service | Local SD WebUI API                      |

---

## Totals

| Category           | Sites/Software | Commands  |
| ------------------ | -------------- | --------- |
| Web                | 81             | ~470      |
| Desktop / Service  | 33             | ~200+     |
| Bridge / Tools     | 12             | ~30+      |
| **0.2xx Total**    | **126**        | **~700+** |
| **Done (0.200.0)** | **21**         | **74**    |

---

## Implementation Phases

### Phase 0: Self-Healing Engine ✅ COMPLETE

- [x] Structured error JSON from pipeline failures (PipelineError with adapter_path, step, action, suggestion)
- [x] `unicli repair <site> <command>` diagnostic with verbose tracing
- [x] User adapter overlay: `~/.unicli/adapters/` overrides built-in
- [x] `unicli test [site]` health check for all commands
- [x] Desktop adapter subprocess executor (`exec` step)
- [x] Pipe filter system (15 filters: join, urlencode, truncate, strip_html, etc.)
- [x] RSS/XML parsing (`fetch_text` + `parse_rss`)
- [x] Sort step, resilient loader

### Phase 1: Public API Adapters ✅ COMPLETE (21 sites, 74 commands)

- [x] hackernews 8/8: top, best, new, show, ask, jobs, search, user
- [x] reddit 8/8: hot, search, frontpage, popular, subreddit, user, user-posts, user-comments
- [x] lobsters 4, stackoverflow 4, bluesky 9, devto 3, dictionary 3, steam 1
- [x] bbc 1, wikipedia 4, arxiv 2, apple-podcasts 3, hf 1, xiaoyuzhou 1
- [x] bloomberg 9, v2ex 7, weread 2
- [x] github-trending 1, ollama 1, blender 1, ffmpeg 1 (pre-existing)

### Phase 2: Top Cookie Adapters (15 sites, browser extension)

1. bilibili (13 cmds) — largest Chinese platform
2. twitter (26 cmds) — most commands
3. youtube (5 cmds) — highest daily usage
4. weibo (7 cmds), zhihu (4 cmds) — Chinese discourse
5. douban (9 cmds), xiaohongshu (13 cmds) — Chinese social
6. instagram (15 cmds), tiktok (15 cmds) — global social
7. amazon (5 cmds) — e-commerce
8. weread (7 cmds), xueqiu (10 cmds) — reading, finance
9. linkedin (2 cmds) — professional
10. medium (3 cmds), substack (3 cmds) — long-form

### Phase 3: Desktop Adapters (top 15)

1. gimp, inkscape — image processing (broad use)
2. libreoffice — office docs (headless)
3. ffmpeg (✅), imagemagick, pandoc — format conversion
4. yt-dlp, whisper — media
5. blender (✅), freecad — 3D
6. audacity, musescore — audio/music
7. drawio, mermaid — diagrams
8. sqlite3, jq — data processing

### Phase 4: Service + Bridge Adapters

1. ollama (✅), comfyui, stable-diffusion — local AI
2. wiremock, adguardhome — dev/network
3. zotero, zoom — productivity
4. gh, docker, vercel — dev tools (bridge)
5. ripgrep, wget — CLI tools (bridge)

### Phase 5: UI Adapters + Remaining

1. cursor, codex, chatgpt — AI tools
2. notion, discord-app — productivity
3. All remaining cookie adapters
4. All remaining niche adapters

---

## Non-Adapter Work for 0.2xx

### Done

- [x] Self-repair commands: `unicli repair`, `unicli test`
- [x] Structured error output protocol (JSON to stderr)
- [x] User adapter overlay (~/.unicli/adapters/)
- [x] Build manifest (dist/manifest.json)
- [x] Unit tests (18 tests, all passing)
- [x] Architecture document (docs/ARCHITECTURE.md)

### Next (0.2xx)

- [ ] First commit + push to GitHub
- [ ] npm publish
- [ ] Demo GIF: self-repair loop (agent fixes broken adapter)
- [ ] Browser extension (Chrome MV3) for cookie strategy
- [ ] Cookie adapter tier: bilibili, twitter, xiaohongshu, weibo, zhihu
- [ ] Desktop adapter tier: gimp, inkscape, libreoffice, imagemagick, pandoc
- [ ] Bridge adapter tier: gh, docker, yt-dlp, jq
- [ ] MCP server (optional, lazy registration — NOT upfront tool dump)
- [ ] `unicli operate` — browser automation with API recording

### Not Planned

- ~~Plugin system~~ — premature; YAML overlay is sufficient
- ~~GitHub Pages~~ — premature; README is the doc
- ~~Logo design~~ — premature; ship first
