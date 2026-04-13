<!-- AGENT: npm install -g @zenalexa/unicli && unicli search "your intent" | 1020 commands across 198 sites. JSON when piped. Self-repairing YAML adapters. Bilingual search (EN/ZH). See AGENTS.md -->

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
  <img alt="Uni-CLI" src="assets/logo-light.svg" width="420">
</picture>

<br><br>

**The compiler that turns the internet into CLI commands for AI agents.**

<br>

<img src="https://img.shields.io/badge/198_sites-1020_commands-00d4aa?style=flat-square" alt="coverage">
<img src="https://img.shields.io/badge/~80_tokens-per_call-E8A838?style=flat-square" alt="tokens">
<img src="https://img.shields.io/badge/self--repairing-YAML_adapters-8B5CF6?style=flat-square" alt="self-repair">
<a href="https://www.npmjs.com/package/@zenalexa/unicli"><img src="https://img.shields.io/npm/v/@zenalexa/unicli?style=flat-square&color=cb3837" alt="npm"></a>
<a href="https://github.com/olo-dot-io/Uni-CLI/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/olo-dot-io/Uni-CLI/ci.yml?style=flat-square&label=CI" alt="CI"></a>
<a href="./LICENSE"><img src="https://img.shields.io/github/license/olo-dot-io/Uni-CLI?style=flat-square" alt="license"></a>

<br><br>

```
npm install -g @zenalexa/unicli
```

</div>

---

```bash
unicli search "推特热门"                   # Bilingual discovery → twitter trending
unicli hackernews top --limit 5          # Hacker News front page
unicli twitter search "AI agents"        # Twitter (authenticated)
unicli bilibili hot                      # Bilibili trending
unicli blender render scene.blend        # Render a 3D scene
unicli notion search "meeting notes"     # Search Notion
unicli macos screenshot                  # macOS screenshot
unicli ffmpeg compress video.mp4         # Compress video
```

Every command outputs **structured JSON when piped** — zero flags needed. Every error emits structured JSON to stderr with the adapter path, the failing step, and a fix suggestion. **~80 tokens per call.**

```mermaid
graph LR
    A[AI Agent] -->|"unicli search 'intent'"| B["Uni-CLI"]
    B --> C["YAML Adapter<br>~20 lines"]
    C --> D["Web API"]
    C --> E["Chrome CDP"]
    C --> F["Subprocess"]
    B -.->|self-repair| C
```

## Key Ideas

**Universal** — 198 sites, 30+ desktop apps, 8 Electron apps, 35 CLI bridges, 51 macOS system commands. One interface: `unicli <site> <command>`.

**Discoverable** — BM25 bilingual search engine. `unicli search "推特热门"` finds `twitter trending`. `unicli search "download video"` finds `bilibili download`. Agents find what they need in one call.

**Self-repairing** — When a site changes its API, the agent reads the ~20 line YAML adapter, fixes it, retries. No human in the loop. Fixes persist across updates.

**Agent-native** — Piped output auto-switches to JSON. Errors are machine-parseable. Exit codes follow `sysexits.h`. The agent doesn't need flags or special handling.

**Cheap** — ~80 tokens per CLI invocation vs 55,000 tokens for an MCP tool catalog. Three orders of magnitude cheaper in context window cost.

## Self-Repair

The core differentiator. When a command breaks, agents fix it themselves:

```mermaid
flowchart LR
    A["unicli site cmd\n❌ fails"] --> B["Structured error\n{adapter_path, step, suggestion}"]
    B --> C["Agent reads\n20-line YAML"]
    C --> D["Agent edits\nthe adapter"]
    D --> E["unicli site cmd\n✅ works"]
    E --> F["Fix persists in\n~/.unicli/adapters/"]
```

```bash
unicli repair hackernews top      # Diagnose + suggest fix
unicli test hackernews            # Validate adapter
unicli repair --loop              # Autonomous fix loop
```

Fixes are saved to `~/.unicli/adapters/` and survive `npm update`.

## Supported Platforms

<table><tr><td>

**198 sites** · **1020 commands** · **35 pipeline steps** · **BM25 bilingual search**

</td></tr></table>

<!-- =========================== -->
<!--    WEB — SOCIAL MEDIA       -->
<!-- =========================== -->

<details open>
<summary><strong>Social Media — 25 sites</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://cdn.simpleicons.org/x/000000" width="16"> <b>Twitter</b> <sup>35</sup></td>
    <td><img src="https://cdn.simpleicons.org/reddit/FF4500" width="16"> <b>Reddit</b> <sup>20</sup></td>
    <td><img src="https://cdn.simpleicons.org/instagram/E4405F" width="16"> <b>Instagram</b> <sup>26</sup></td>
    <td><img src="https://cdn.simpleicons.org/tiktok/000000" width="16"> <b>TikTok</b> <sup>16</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/facebook/0866FF" width="16"> <b>Facebook</b> <sup>12</sup></td>
    <td><img src="https://cdn.simpleicons.org/bluesky/0085FF" width="16"> <b>Bluesky</b> <sup>12</sup></td>
    <td><img src="https://cdn.simpleicons.org/medium/000000" width="16"> <b>Medium</b> <sup>5</sup></td>
    <td><img src="https://cdn.simpleicons.org/threads/000000" width="16"> <b>Threads</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/mastodon/6364FF" width="16"> <b>Mastodon</b> <sup>4</sup></td>
    <td><img src="https://cdn.simpleicons.org/bilibili/00A1D6" width="16"> <b>Bilibili</b> <sup>18</sup></td>
    <td><img src="https://cdn.simpleicons.org/sinaweibo/E6162D" width="16"> <b>Weibo</b> <sup>10</sup></td>
    <td><img src="https://cdn.simpleicons.org/zhihu/0084FF" width="16"> <b>Zhihu</b> <sup>21</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=xiaohongshu.com&sz=32" width="16"> <b>Xiaohongshu</b> <sup>24</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=douyin.com&sz=32" width="16"> <b>Douyin</b> <sup>23</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=okjike.com&sz=32" width="16"> <b>Jike</b> <sup>10</sup></td>
    <td><img src="https://cdn.simpleicons.org/douban/007722" width="16"> <b>Douban</b> <sup>12</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=v2ex.com&sz=32" width="16"> <b>V2EX</b> <sup>12</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=linux.do&sz=32" width="16"> <b>Linux.do</b> <sup>10</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=weread.qq.com&sz=32" width="16"> <b>WeRead</b> <sup>7</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=tieba.baidu.com&sz=32" width="16"> <b>Tieba</b> <sup>4</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=zsxq.com&sz=32" width="16"> <b>Zsxq</b> <sup>5</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=xiaoyuzhou.fm&sz=32" width="16"> <b>Xiaoyuzhou</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=blog.sina.com.cn&sz=32" width="16"> <b>Sinablog</b> <sup>4</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=toutiao.com&sz=32" width="16"> <b>Toutiao</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=baidu.com&sz=32" width="16"> <b>Baidu</b> <sup>2</sup></td>
    <td></td>
    <td></td>
    <td></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    WEB — TECH & DEV         -->
<!-- =========================== -->

<details>
<summary><strong>Tech & Developer — 19 sites</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://cdn.simpleicons.org/ycombinator/FF6600" width="16"> <b>Hacker News</b> <sup>10</sup></td>
    <td><img src="https://cdn.simpleicons.org/stackoverflow/F58025" width="16"> <b>Stack Overflow</b> <sup>6</sup></td>
    <td><img src="https://cdn.simpleicons.org/devdotto/0A0A0A" width="16"> <b>DEV</b> <sup>5</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=lobste.rs&sz=32" width="16"> <b>Lobsters</b> <sup>5</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/producthunt/DA552F" width="16"> <b>Product Hunt</b> <sup>5</sup></td>
    <td><img src="https://cdn.simpleicons.org/github/181717" width="16"> <b>GitHub Trending</b> <sup>3</sup></td>
    <td><img src="https://cdn.simpleicons.org/substack/FF6719" width="16"> <b>Substack</b> <sup>4</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=lesswrong.com&sz=32" width="16"> <b>LessWrong</b> <sup>15</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/npm/CB3837" width="16"> <b>npm</b> <sup>4</sup></td>
    <td><img src="https://cdn.simpleicons.org/pypi/3775A9" width="16"> <b>PyPI</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=crates.io&sz=32" width="16"> <b>crates.io</b> <sup>3</sup></td>
    <td><img src="https://cdn.simpleicons.org/cocoapods/EE3322" width="16"> <b>CocoaPods</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/homebrew/FBB040" width="16"> <b>Homebrew</b> <sup>2</sup></td>
    <td><img src="https://cdn.simpleicons.org/gitlab/FC6D26" width="16"> <b>GitLab</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=gitee.com&sz=32" width="16"> <b>Gitee</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=npmtrends.com&sz=32" width="16"> <b>npm trends</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/docker/2496ED" width="16"> <b>Docker Hub</b> <sup>3</sup></td>
    <td><img src="https://cdn.simpleicons.org/ycombinator/FF6600" width="16"> <b>Y Combinator</b> <sup>1</sup></td>
    <td><img src="https://cdn.simpleicons.org/itchdotio/FA5C5C" width="16"> <b>itch.io</b> <sup>3</sup></td>
    <td></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    WEB — AI & ML            -->
<!-- =========================== -->

<details>
<summary><strong>AI & ML — 16 sites</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://cdn.simpleicons.org/googlegemini/8E75B2" width="16"> <b>Gemini</b> <sup>5</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=grok.x.ai&sz=32" width="16"> <b>Grok</b> <sup>1</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=deepseek.com&sz=32" width="16"> <b>DeepSeek</b> <sup>2</sup></td>
    <td><img src="https://cdn.simpleicons.org/perplexity/1FB8CD" width="16"> <b>Perplexity</b> <sup>1</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=doubao.com&sz=32" width="16"> <b>Doubao Web</b> <sup>9</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=notebooklm.google.com&sz=32" width="16"> <b>NotebookLM</b> <sup>15</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=yollomi.com&sz=32" width="16"> <b>Yollomi</b> <sup>12</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=jimeng.jianying.com&sz=32" width="16"> <b>Jimeng</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=yuanbao.tencent.com&sz=32" width="16"> <b>Yuanbao</b> <sup>3</sup></td>
    <td><img src="https://cdn.simpleicons.org/ollama/000000" width="16"> <b>Ollama</b> <sup>4</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=openrouter.ai&sz=32" width="16"> <b>OpenRouter</b> <sup>2</sup></td>
    <td><img src="https://cdn.simpleicons.org/huggingface/FFD21E" width="16"> <b>Hugging Face</b> <sup>6</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=replicate.com&sz=32" width="16"> <b>Replicate</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=minimaxi.com&sz=32" width="16"> <b>MiniMax</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=doubao.com&sz=32" width="16"> <b>Doubao API</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=novita.ai&sz=32" width="16"> <b>Novita</b> <sup>3</sup></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    WEB — VIDEO & STREAMING  -->
<!-- =========================== -->

<details>
<summary><strong>Video & Streaming — 8 sites</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://cdn.simpleicons.org/youtube/FF0000" width="16"> <b>YouTube</b> <sup>9</sup></td>
    <td><img src="https://cdn.simpleicons.org/twitch/9146FF" width="16"> <b>Twitch</b> <sup>4</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=kuaishou.com&sz=32" width="16"> <b>Kuaishou</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=douyu.com&sz=32" width="16"> <b>Douyu</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=channels.weixin.qq.com&sz=32" width="16"> <b>WeChat Channels</b> <sup>2</sup></td>
    <td><img src="https://cdn.simpleicons.org/applepodcasts/9933CC" width="16"> <b>Apple Podcasts</b> <sup>3</sup></td>
    <td><img src="https://cdn.simpleicons.org/spotify/1DB954" width="16"> <b>Spotify</b> <sup>4</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=music.163.com&sz=32" width="16"> <b>NetEase Music</b> <sup>4</sup></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    WEB — NEWS & MEDIA       -->
<!-- =========================== -->

<details>
<summary><strong>News & Media — 10 sites</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://cdn.simpleicons.org/bloomberg/2800D7" width="16"> <b>Bloomberg</b> <sup>10</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=reuters.com&sz=32" width="16"> <b>Reuters</b> <sup>4</sup></td>
    <td><img src="https://cdn.simpleicons.org/bbc/000000" width="16"> <b>BBC</b> <sup>4</sup></td>
    <td><img src="https://cdn.simpleicons.org/cnn/CC0000" width="16"> <b>CNN</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/newyorktimes/000000" width="16"> <b>NYTimes</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=36kr.com&sz=32" width="16"> <b>36Kr</b> <sup>5</sup></td>
    <td><img src="https://cdn.simpleicons.org/techcrunch/029E74" width="16"> <b>TechCrunch</b> <sup>2</sup></td>
    <td><img src="https://cdn.simpleicons.org/theverge/000000" width="16"> <b>The Verge</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=infoq.com&sz=32" width="16"> <b>InfoQ</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=ithome.com&sz=32" width="16"> <b>IT Home</b> <sup>3</sup></td>
    <td></td>
    <td></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    WEB — FINANCE            -->
<!-- =========================== -->

<details>
<summary><strong>Finance & Trading — 8 sites</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=xueqiu.com&sz=32" width="16"> <b>Xueqiu</b> <sup>12</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=finance.sina.com.cn&sz=32" width="16"> <b>Sina Finance</b> <sup>5</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=barchart.com&sz=32" width="16"> <b>Barchart</b> <sup>4</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=finance.yahoo.com&sz=32" width="16"> <b>Yahoo Finance</b> <sup>3</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/binance/F0B90B" width="16"> <b>Binance</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=futunn.com&sz=32" width="16"> <b>Futu</b> <sup>2</sup></td>
    <td><img src="https://cdn.simpleicons.org/coinbase/0052FF" width="16"> <b>Coinbase</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=eastmoney.com&sz=32" width="16"> <b>Eastmoney</b> <sup>4</sup></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    WEB — SHOPPING & LIFE    -->
<!-- =========================== -->

<details>
<summary><strong>Shopping & Lifestyle — 14 sites</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://cdn.simpleicons.org/amazon/FF9900" width="16"> <b>Amazon</b> <sup>8</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=jd.com&sz=32" width="16"> <b>JD</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=taobao.com&sz=32" width="16"> <b>Taobao</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=1688.com&sz=32" width="16"> <b>1688</b> <sup>3</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=pinduoduo.com&sz=32" width="16"> <b>Pinduoduo</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=smzdm.com&sz=32" width="16"> <b>SMZDM</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=meituan.com&sz=32" width="16"> <b>Meituan</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=ele.me&sz=32" width="16"> <b>Ele.me</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=dianping.com&sz=32" width="16"> <b>Dianping</b> <sup>2</sup></td>
    <td><img src="https://cdn.simpleicons.org/coupang/BE1216" width="16"> <b>Coupang</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=ctrip.com&sz=32" width="16"> <b>Ctrip</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=xianyu.com&sz=32" width="16"> <b>Xianyu</b> <sup>3</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=dangdang.com&sz=32" width="16"> <b>Dangdang</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=maoyan.com&sz=32" width="16"> <b>Maoyan</b> <sup>2</sup></td>
    <td></td>
    <td></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    WEB — JOBS               -->
<!-- =========================== -->

<details>
<summary><strong>Jobs & Careers — 2 sites</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=zhipin.com&sz=32" width="16"> <b>Boss Zhipin</b> <sup>14</sup></td>
    <td><img src="https://cdn.simpleicons.org/linkedin/0A66C2" width="16"> <b>LinkedIn</b> <sup>4</sup></td>
    <td></td>
    <td></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    WEB — REFERENCE          -->
<!-- =========================== -->

<details>
<summary><strong>Education & Reference — 14 sites</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://cdn.simpleicons.org/google/4285F4" width="16"> <b>Google</b> <sup>4</sup></td>
    <td><img src="https://cdn.simpleicons.org/wikipedia/000000" width="16"> <b>Wikipedia</b> <sup>5</sup></td>
    <td><img src="https://cdn.simpleicons.org/arxiv/B31B1B" width="16"> <b>arXiv</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=cnki.net&sz=32" width="16"> <b>CNKI</b> <sup>1</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=chaoxing.com&sz=32" width="16"> <b>Chaoxing</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=dictionary.com&sz=32" width="16"> <b>Dictionary</b> <sup>3</sup></td>
    <td><img src="https://cdn.simpleicons.org/imdb/F5C518" width="16"> <b>IMDb</b> <sup>7</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=paperreview.com&sz=32" width="16"> <b>PaperReview</b> <sup>3</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=exchangerate-api.com&sz=32" width="16"> <b>Exchange Rate</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=ipinfo.io&sz=32" width="16"> <b>IP Info</b> <sup>1</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=qweather.com&sz=32" width="16"> <b>QWeather</b> <sup>2</sup></td>
    <td><img src="https://cdn.simpleicons.org/unsplash/000000" width="16"> <b>Unsplash</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/pexels/05A081" width="16"> <b>Pexels</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=sspai.com&sz=32" width="16"> <b>Sspai</b> <sup>2</sup></td>
    <td></td>
    <td></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    WEB — OTHER              -->
<!-- =========================== -->

<details>
<summary><strong>Other Web — 14 sites</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=ones.com&sz=32" width="16"> <b>Ones</b> <sup>11</sup></td>
    <td><img src="https://cdn.simpleicons.org/pixiv/0096FA" width="16"> <b>Pixiv</b> <sup>6</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=hupu.com&sz=32" width="16"> <b>Hupu</b> <sup>7</sup></td>
    <td><img src="https://cdn.simpleicons.org/steam/000000" width="16"> <b>Steam</b> <sup>6</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=band.us&sz=32" width="16"> <b>Band</b> <sup>4</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=xiaoe-tech.com&sz=32" width="16"> <b>Xiaoe</b> <sup>5</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=quark.cn&sz=32" width="16"> <b>Quark</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=mubu.com&sz=32" width="16"> <b>Mubu</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=ke.com&sz=32" width="16"> <b>Ke.com</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=maimai.cn&sz=32" width="16"> <b>Maimai</b> <sup>1</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=feishu.cn&sz=32" width="16"> <b>Feishu</b> <sup>4</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=slock.it&sz=32" width="16"> <b>Slock</b> <sup>1</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=jianyu.com&sz=32" width="16"> <b>Jianyu</b> <sup>1</sup></td>
    <td><img src="https://cdn.simpleicons.org/wechat/07C160" width="16"> <b>WeChat</b> <sup>4</sup></td>
    <td></td>
    <td></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    DESKTOP SOFTWARE         -->
<!-- =========================== -->

<details>
<summary><strong>Desktop Software — 30 apps</strong></summary>
<br>
<table>
  <tr>
    <th colspan="4">3D / CAD</th>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/blender/E87D0D" width="16"> <b>Blender</b> <sup>13</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=freecad.org&sz=32" width="16"> <b>FreeCAD</b> <sup>15</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=cloudcompare.org&sz=32" width="16"> <b>CloudCompare</b> <sup>4</sup></td>
    <td><img src="https://cdn.simpleicons.org/godotengine/478CBF" width="16"> <b>Godot</b> <sup>2</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=renderdoc.org&sz=32" width="16"> <b>RenderDoc</b> <sup>2</sup></td>
    <td></td>
    <td></td>
    <td></td>
  </tr>
  <tr>
    <th colspan="4">Image</th>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/gimp/5C5543" width="16"> <b>GIMP</b> <sup>12</sup></td>
    <td><img src="https://cdn.simpleicons.org/inkscape/000000" width="16"> <b>Inkscape</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=imagemagick.org&sz=32" width="16"> <b>ImageMagick</b> <sup>6</sup></td>
    <td><img src="https://cdn.simpleicons.org/krita/3BABFF" width="16"> <b>Krita</b> <sup>4</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/sketch/F7B500" width="16"> <b>Sketch</b> <sup>3</sup></td>
    <td></td>
    <td></td>
    <td></td>
  </tr>
  <tr>
    <th colspan="4">Video / Audio</th>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/ffmpeg/007808" width="16"> <b>FFmpeg</b> <sup>11</sup></td>
    <td><img src="https://cdn.simpleicons.org/kdenlive/527EB2" width="16"> <b>Kdenlive</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=shotcut.org&sz=32" width="16"> <b>Shotcut</b> <sup>3</sup></td>
    <td><img src="https://cdn.simpleicons.org/audacity/0000CC" width="16"> <b>Audacity</b> <sup>8</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/musescore/1A70B8" width="16"> <b>MuseScore</b> <sup>5</sup></td>
    <td></td>
    <td></td>
    <td></td>
  </tr>
  <tr>
    <th colspan="4">Productivity</th>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/obsstudio/302E31" width="16"> <b>OBS Studio</b> <sup>8</sup></td>
    <td><img src="https://cdn.simpleicons.org/zotero/CC2936" width="16"> <b>Zotero</b> <sup>8</sup></td>
    <td><img src="https://cdn.simpleicons.org/visualstudiocode/007ACC" width="16"> <b>VS Code</b> <sup>3</sup></td>
    <td><img src="https://cdn.simpleicons.org/obsidian/7C3AED" width="16"> <b>Obsidian</b> <sup>3</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/notion/000000" width="16"> <b>Notion</b> <sup>3</sup></td>
    <td><img src="https://cdn.simpleicons.org/libreoffice/18A303" width="16"> <b>LibreOffice</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=pandoc.org&sz=32" width="16"> <b>Pandoc</b> <sup>1</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=draw.io&sz=32" width="16"> <b>Draw.io</b> <sup>1</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=mermaid.js.org&sz=32" width="16"> <b>Mermaid</b> <sup>1</sup></td>
    <td></td>
    <td></td>
    <td></td>
  </tr>
  <tr>
    <th colspan="4">Other</th>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/googlechrome/4285F4" width="16"> <b>Chrome</b> <sup>2</sup></td>
    <td><img src="https://cdn.simpleicons.org/zoom/0B5CFF" width="16"> <b>Zoom</b> <sup>2</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=wiremock.org&sz=32" width="16"> <b>WireMock</b> <sup>5</sup></td>
    <td><img src="https://cdn.simpleicons.org/adguard/68BC71" width="16"> <b>AdGuard Home</b> <sup>5</sup></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=comfyui.com&sz=32" width="16"> <b>ComfyUI</b> <sup>4</sup></td>
    <td><img src="https://cdn.simpleicons.org/steam/000000" width="16"> <b>Slay the Spire II</b> <sup>6</sup></td>
    <td></td>
    <td></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    ELECTRON APPS            -->
<!-- =========================== -->

<details>
<summary><strong>Electron Apps — 8 apps, 70+ commands</strong></summary>
<br>

All via Chrome DevTools Protocol — no extensions, no hacks.

<table>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=32" width="16"> <b>Cursor</b></td>
    <td>ask, send, read, model, composer, extract-code, new, status, screenshot, dump, history, export</td>
    <td><code>9226</code></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/openai/412991" width="16"> <b>Codex</b></td>
    <td>ask, send, read, model, extract-diff, new, status, screenshot, dump, history, export</td>
    <td><code>9222</code></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/openai/412991" width="16"> <b>ChatGPT</b></td>
    <td>ask, send, read, model, new, status, screenshot, dump</td>
    <td><code>9236</code></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/notion/000000" width="16"> <b>Notion</b></td>
    <td>search, read, write, new, status, sidebar, favorites, export, screenshot</td>
    <td><code>9230</code></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/discord/5865F2" width="16"> <b>Discord</b></td>
    <td>servers, channels, read, send, search, members, status, delete</td>
    <td><code>9232</code></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=chatwise.app&sz=32" width="16"> <b>ChatWise</b></td>
    <td>ask, send, read, model, new, status, screenshot, dump</td>
    <td><code>9228</code></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=doubao.com&sz=32" width="16"> <b>Doubao</b></td>
    <td>ask, send, read, new, status, screenshot, dump</td>
    <td><code>9225</code></td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=antigravity.ai&sz=32" width="16"> <b>Antigravity</b></td>
    <td>ask, send, read, model, new, status, screenshot, dump</td>
    <td><code>9234</code></td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    CLI BRIDGES              -->
<!-- =========================== -->

<details>
<summary><strong>CLI Bridges — 35 tools</strong></summary>
<br>

Passthrough wrappers that normalize output to JSON:

<table>
  <tr>
    <td><img src="https://cdn.simpleicons.org/docker/2496ED" width="16"> Docker</td>
    <td><img src="https://cdn.simpleicons.org/github/181717" width="16"> gh</td>
    <td><img src="https://www.google.com/s2/favicons?domain=jqlang.github.io&sz=32" width="16"> jq</td>
    <td><img src="https://www.google.com/s2/favicons?domain=yt-dl.org&sz=32" width="16"> yt-dlp</td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/vercel/000000" width="16"> Vercel</td>
    <td><img src="https://cdn.simpleicons.org/supabase/3FCF8E" width="16"> Supabase</td>
    <td><img src="https://cdn.simpleicons.org/cloudflare/F38020" width="16"> Wrangler</td>
    <td><img src="https://www.google.com/s2/favicons?domain=feishu.cn&sz=32" width="16"> Lark</td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=dingtalk.com&sz=32" width="16"> DingTalk</td>
    <td><img src="https://cdn.simpleicons.org/huggingface/FFD21E" width="16"> HF CLI</td>
    <td><img src="https://cdn.simpleicons.org/anthropic/191919" width="16"> Claude Code</td>
    <td><img src="https://cdn.simpleicons.org/openai/412991" width="16"> Codex CLI</td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=32" width="16"> OpenCode</td>
    <td><img src="https://cdn.simpleicons.org/amazonaws/232F3E" width="16"> AWS</td>
    <td><img src="https://cdn.simpleicons.org/googlecloud/4285F4" width="16"> GCloud</td>
    <td><img src="https://cdn.simpleicons.org/microsoftazure/0078D4" width="16"> Azure</td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/digitalocean/0080FF" width="16"> DigitalOcean</td>
    <td><img src="https://cdn.simpleicons.org/netlify/00C7B7" width="16"> Netlify</td>
    <td><img src="https://cdn.simpleicons.org/railway/0B0D0E" width="16"> Railway</td>
    <td><img src="https://www.google.com/s2/favicons?domain=fly.io&sz=32" width="16"> Fly.io</td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/planetscale/000000" width="16"> PlanetScale</td>
    <td><img src="https://www.google.com/s2/favicons?domain=neon.tech&sz=32" width="16"> Neon</td>
    <td><img src="https://cdn.simpleicons.org/slack/4A154B" width="16"> Slack</td>
    <td><img src="https://www.google.com/s2/favicons?domain=kimi.ai&sz=32" width="16"> Kimi CLI</td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/google/4285F4" width="16"> GWS</td>
    <td><img src="https://www.google.com/s2/favicons?domain=deepagents.ai&sz=32" width="16"> DeepAgents</td>
    <td><img src="https://cdn.simpleicons.org/stripe/635BFF" width="16"> Stripe</td>
    <td><img src="https://cdn.simpleicons.org/firebase/DD2C00" width="16"> Firebase</td>
  </tr>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=minimaxi.com&sz=32" width="16"> MMX CLI</td>
    <td><img src="https://www.google.com/s2/favicons?domain=wecom.work&sz=32" width="16"> WeCom</td>
    <td><img src="https://www.google.com/s2/favicons?domain=mem0.ai&sz=32" width="16"> Mem0</td>
    <td>+ more</td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    macOS SYSTEM             -->
<!-- =========================== -->

<details>
<summary><strong><img src="https://cdn.simpleicons.org/apple/000000" width="16"> macOS System — 51 commands</strong></summary>
<br>
<table>
  <tr>
    <th>Audio/Display</th>
    <td>volume, brightness, dark-mode, say</td>
  </tr>
  <tr>
    <th>Power/System</th>
    <td>battery, lock-screen, caffeinate, sleep, uptime, system-info</td>
  </tr>
  <tr>
    <th>Files/Search</th>
    <td>spotlight, disk-info, trash, empty-trash, open, finder-tags, finder-recent, finder-selection</td>
  </tr>
  <tr>
    <th>Network</th>
    <td>wifi, wifi-info, bluetooth</td>
  </tr>
  <tr>
    <th>Notifications</th>
    <td>notify, notification, do-not-disturb</td>
  </tr>
  <tr>
    <th>Apps</th>
    <td>apps, apps-list, active-app, open-app, safari-tabs, shortcuts-list, shortcuts-run</td>
  </tr>
  <tr>
    <th>PIM</th>
    <td>calendar-list, calendar-create, calendar-today, contacts-search, mail-status, mail-send, messages-send, reminders-list, reminders-create, reminders-complete</td>
  </tr>
  <tr>
    <th>Media</th>
    <td>music-now, music-control, photos-search, notes-list, notes-search, screenshot, clipboard, processes</td>
  </tr>
</table>
</details>

<!-- =========================== -->
<!--    AGENT PLATFORMS          -->
<!-- =========================== -->

<details>
<summary><strong>Agent Platforms — 5 integrations</strong></summary>
<br>
<table>
  <tr>
    <td><img src="https://www.google.com/s2/favicons?domain=hermes.ai&sz=32" width="16"> <b>Hermes</b> <sup>3</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=autoagent.dev&sz=32" width="16"> <b>AutoAgent</b> <sup>1</sup></td>
    <td><img src="https://www.google.com/s2/favicons?domain=stagehand.dev&sz=32" width="16"> <b>Stagehand</b> <sup>1</sup></td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/github/181717" width="16"> <b>OpenHarness</b> <sup>2</sup></td>
    <td><img src="https://cdn.simpleicons.org/openai/412991" width="16"> <b>CUA</b> <sup>2</sup></td>
    <td></td>
  </tr>
</table>
</details>

## Architecture

```mermaid
graph TB
    CMD["unicli &lt;site&gt; &lt;command&gt; [args]"]

    CMD --> YAML["YAML Adapter<br/><i>~20 lines, agent-editable</i>"]
    CMD --> TS["TS Adapter<br/><i>complex logic</i>"]
    CMD --> BRIDGE["Bridge<br/><i>passthrough to CLI</i>"]

    YAML --> ENGINE
    TS --> ENGINE
    BRIDGE --> ENGINE

    subgraph ENGINE ["Pipeline Engine — 35 steps"]
        direction LR
        API["fetch  fetch_text<br/>parse_rss  html_to_md"]
        TRANSFORM["select  map  filter<br/>sort  limit"]
        BROWSER["navigate  evaluate<br/>click  type  press<br/>scroll  intercept<br/>snapshot  tap  extract"]
        CONTROL["set  if  each<br/>parallel  append<br/>rate_limit  assert  retry"]
        OTHER["exec  write_temp<br/>download  websocket"]
    end

    ENGINE --> CDP["Direct CDP"]
    ENGINE --> DAEMON["Browser Daemon<br/><i>reuses Chrome logins</i>"]

    CDP --> OUT["Output Formatter<br/><i>table · json · yaml · csv · md</i>"]
    DAEMON --> OUT
```

Remote browser support via `UNICLI_CDP_ENDPOINT` — connect to any CDP WebSocket (Cloudflare Browser Rendering, Browserless, or self-hosted).

## Write an Adapter

Most adapters are ~20 lines of YAML:

```yaml
site: hackernews
name: top
type: web-api
strategy: public
pipeline:
  - fetch:
      url: "https://hacker-news.firebaseio.com/v0/topstories.json"
  - limit: { count: "${{ args.limit | default(30) }}" }
  - each:
      do:
        - fetch:
            url: "https://hacker-news.firebaseio.com/v0/item/${{ item }}.json"
      max: "${{ args.limit | default(30) }}"
  - map:
      title: "${{ item.title }}"
      score: "${{ item.score }}"
      url: "${{ item.url }}"
      by: "${{ item.by }}"
columns: [title, score, by, url]
```

Five adapter types: `web-api`, `desktop`, `browser`, `bridge`, `service`.

29 template filters in a sandboxed VM: `join`, `urlencode`, `truncate`, `slugify`, `sanitize`, `basename`, `strip_html`, `default`, `split`, `first`, `last`, `length`, `keys`, `json`, `replace`, `lowercase`, `uppercase`, `trim`, `slice`, `reverse`, `unique`, `abs`, `round`, `ceil`, `floor`, `int`, `float`, `str`, `ext`.

## Authentication

Five strategies, auto-detected via cascade (`PUBLIC → COOKIE → HEADER`):

| Strategy    | How                                                      |
| ----------- | -------------------------------------------------------- |
| `public`    | Direct HTTP — no credentials                             |
| `cookie`    | Injects cookies from `~/.unicli/cookies/<site>.json`     |
| `header`    | Cookie + auto-extracted CSRF token (ct0, bili_jct, etc.) |
| `intercept` | Navigates page in Chrome, captures XHR/fetch responses   |
| `ui`        | Direct DOM interaction (click, type, submit)             |

```bash
unicli auth setup twitter    # Show required cookies + template
unicli auth check twitter    # Validate cookie file
unicli auth list             # List configured sites
```

## Browser Daemon

Persistent background process that reuses your Chrome login sessions — no cookie export, no extension install:

```bash
unicli daemon status             # Check daemon
unicli operate open <url>        # Navigate
unicli operate state             # DOM accessibility snapshot
unicli operate click <ref>       # Click by ref
unicli operate type <ref> <text> # Type into element
unicli operate eval <js>         # Execute JavaScript
unicli operate screenshot        # Capture page
unicli record <url>              # Auto-generate adapter from traffic
```

13-layer anti-detection stealth: webdriver removal, `chrome.runtime` mock, CDP marker cleanup, `Error.stack` filtering, iframe consistency, and more. Auto-exits after 4h idle.

## Agent Integration

Works with every major agent platform:

```bash
# Claude Code / Codex CLI — direct shell
unicli twitter search "AI agents"

# MCP — one command to expose all 969 commands
unicli mcp serve

# AGENTS.md — discovery file already included in repo
cat AGENTS.md
```

| Platform         | Integration                                     |
| ---------------- | ----------------------------------------------- |
| **Claude Code**  | Bash tool + MCP server + AGENTS.md              |
| **Codex CLI**    | Shell execution + MCP + AGENTS.md (first-class) |
| **OpenClaw**     | Plugin + MCP + ClawHub skill                    |
| **Hermes Agent** | MCP + Skills Hub + persistent shell             |
| **OpenCode**     | MCP via opencode.jsonc + AGENTS.md              |

## Development

```bash
git clone https://github.com/olo-dot-io/Uni-CLI.git && cd Uni-CLI
npm install && npm run verify
```

| Command                | Purpose               |
| ---------------------- | --------------------- |
| `npm run dev`          | Dev run               |
| `npm run build`        | Production build      |
| `npm run typecheck`    | TypeScript strict     |
| `npm run lint`         | Oxlint                |
| `npm run test`         | Unit tests (788)      |
| `npm run test:adapter` | Validate all adapters |
| `npm run verify`       | Full pipeline         |

7 production dependencies: `chalk`, `cli-table3`, `commander`, `js-yaml`, `turndown`, `undici`, `ws`.

## Contributing

The fastest way to contribute: write a [20-line YAML adapter](./CONTRIBUTING.md) for a site you use.

```bash
unicli init <site> <command>     # Scaffold new adapter
unicli dev <path>                # Hot-reload during dev
unicli test <site>               # Validate
```

## Search & Discovery

Agents find commands through bilingual semantic search — no need to memorize site names.

```bash
unicli search "推特热门"              # → twitter trending
unicli search "download video"        # → bilibili download, yt-dlp download, twitter download
unicli search "股票行情"              # → binance ticker, barchart quote, xueqiu quote
unicli search --category finance      # → all finance commands
```

The search engine uses BM25 scoring with a ~200-entry bilingual alias table (Chinese↔English). The entire index is 50KB, searches complete in <10ms.

## Agent Integration

```bash
# CLI direct (any agent with shell access)
npm install -g @zenalexa/unicli

# MCP server (Claude Code, Codex CLI, Hermes, OpenCode)
npx @zenalexa/unicli mcp serve

# MCP with SSE transport (remote connections)
npx @zenalexa/unicli mcp serve --transport sse --port 19826

# MCP with OAuth (enterprise)
npx @zenalexa/unicli mcp serve --transport http --auth
```

| Platform           | One-line Setup                                            |
| ------------------ | --------------------------------------------------------- |
| **Claude Code**    | `claude mcp add unicli -- npx @zenalexa/unicli mcp serve` |
| **Codex CLI**      | Add `[mcp_servers.unicli]` to `~/.codex/config.toml`      |
| **Any MCP client** | `npx @zenalexa/unicli mcp serve` (stdio)                  |

The MCP server exposes 4 meta-tools by default (~200 tokens). `unicli_search` provides bilingual semantic search across all 1020 commands.

## License

[Apache-2.0](./LICENSE)

---

<p align="center">
  <a href="https://github.com/olo-dot-io/Uni-CLI/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=olo-dot-io/Uni-CLI" alt="Contributors">
  </a>
</p>

<p align="center">
  <sub>v0.211.2 — Vostok · Volynov</sub><br>
  <sub>198 sites · 1020 commands · 35 pipeline steps · BM25+TF-IDF bilingual search · MCP 2025-03-26 · 855 tests</sub>
</p>
