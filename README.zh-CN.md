<!-- AGENT: npm install -g @zenalexa/unicli && unicli search "你的意图" — 220 个站点，1283 条命令，自修复 YAML 适配器，BM25 中英双语搜索，比 MCP 少 95–99% token。默认 Markdown envelope；JSON 用 -f json。实时统计见 AGENTS.md。 -->

<div align="center">

<img src="assets/icon.svg" width="180" alt="Uni-CLI">

# Uni-CLI

> 一个 CLI，让 Agent 真正会用网站、应用和电脑。

Uni-CLI 把一句话变成一条能跑的命令。Agent 先搜命令，再执行，拿 Markdown/JSON 结果；网站坏了，还能按错误信息自己修 YAML。

<br>

<img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&duration=2200&pause=700&color=6A5ACD&center=true&vCenter=true&width=720&lines=Find+the+right+command;Run+real+sites+and+apps;Get+JSON+or+Markdown+back;Fix+adapters+without+waiting" alt="Find the right command. Run real sites and apps. Get JSON or Markdown back. Fix adapters without waiting.">

<br>

<a href="https://www.npmjs.com/package/@zenalexa/unicli"><img src="https://img.shields.io/npm/v/@zenalexa/unicli?style=for-the-badge&color=cb3837&label=npm" alt="npm"></a>
<a href="https://github.com/olo-dot-io/Uni-CLI/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/olo-dot-io/Uni-CLI/ci.yml?style=for-the-badge&label=CI" alt="CI"></a>
<a href="https://github.com/olo-dot-io/Uni-CLI/stargazers"><img src="https://img.shields.io/github/stars/olo-dot-io/Uni-CLI?style=for-the-badge" alt="stars"></a>
<a href="./LICENSE"><img src="https://img.shields.io/github/license/olo-dot-io/Uni-CLI?style=for-the-badge" alt="license"></a>
<img src="https://img.shields.io/badge/tests-<!-- STATS:test_count -->7160<!-- /STATS -->-44cc11?style=for-the-badge" alt="tests">
<img src="https://img.shields.io/badge/agent--reach-ally-6a5acd?style=for-the-badge" alt="agent-reach ally">

<br>

<img src="https://img.shields.io/badge/<!-- STATS:site_count -->220<!-- /STATS -->_sites-111827?style=for-the-badge" alt="220 sites">
<img src="https://img.shields.io/badge/<!-- STATS:command_count -->1283<!-- /STATS -->_commands-0f766e?style=for-the-badge" alt="1283 commands">
<img src="https://img.shields.io/badge/58_CLI_bridges-7c3aed?style=for-the-badge" alt="58 CLI bridges">
<img src="https://img.shields.io/badge/v2_AgentEnvelope-2563eb?style=for-the-badge" alt="v2 AgentEnvelope">
<img src="https://img.shields.io/badge/self--repairing_YAML-f97316?style=for-the-badge" alt="self-repairing YAML">

<br>

[English](README.md)

<br>

<pre><code>npm install -g @zenalexa/unicli
unicli search "你的意图"
unicli &lt;站点&gt; &lt;命令&gt; -f json</code></pre>

<br>

<p align="center">
<strong>Web / 社交 / 知识</strong><br>
<img src="https://img.shields.io/badge/微博-E6162D?style=flat-square&logo=sinaweibo&logoColor=white" alt="微博">
<img src="https://img.shields.io/badge/知乎-0084FF?style=flat-square&logo=zhihu&logoColor=white" alt="知乎">
<img src="https://img.shields.io/badge/Bilibili-00A1D6?style=flat-square&logo=bilibili&logoColor=white" alt="哔哩哔哩">
<img src="https://img.shields.io/badge/小红书-FF2442?style=flat-square&logoColor=white" alt="小红书">
<img src="https://img.shields.io/badge/抖音-000000?style=flat-square&logo=tiktok&logoColor=white" alt="抖音">
<img src="https://img.shields.io/badge/Twitter%2FX-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X">
<img src="https://img.shields.io/badge/Reddit-FF4500?style=flat-square&logo=reddit&logoColor=white" alt="Reddit">
<img src="https://img.shields.io/badge/Instagram-E4405F?style=flat-square&logo=instagram&logoColor=white" alt="Instagram">
<img src="https://img.shields.io/badge/TikTok-000000?style=flat-square&logo=tiktok&logoColor=white" alt="TikTok">
<img src="https://img.shields.io/badge/YouTube-FF0000?style=flat-square&logo=youtube&logoColor=white" alt="YouTube">
<img src="https://img.shields.io/badge/HackerNews-FF6600?style=flat-square&logo=ycombinator&logoColor=white" alt="HackerNews">
<img src="https://img.shields.io/badge/StackOverflow-F58025?style=flat-square&logo=stackoverflow&logoColor=white" alt="StackOverflow">
<img src="https://img.shields.io/badge/ProductHunt-DA552F?style=flat-square&logo=producthunt&logoColor=white" alt="ProductHunt">
<img src="https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub">
<img src="https://img.shields.io/badge/npm-CB3837?style=flat-square&logo=npm&logoColor=white" alt="npm">
<img src="https://img.shields.io/badge/PyPI-3775A9?style=flat-square&logo=pypi&logoColor=white" alt="PyPI">
<img src="https://img.shields.io/badge/Wikipedia-000000?style=flat-square&logo=wikipedia&logoColor=white" alt="Wikipedia">
<img src="https://img.shields.io/badge/Spotify-1DB954?style=flat-square&logo=spotify&logoColor=white" alt="Spotify">
<img src="https://img.shields.io/badge/IMDb-F5C518?style=flat-square&logo=imdb&logoColor=black" alt="IMDb">
<img src="https://img.shields.io/badge/Bloomberg-000000?style=flat-square&logoColor=white" alt="Bloomberg">
<img src="https://img.shields.io/badge/Reuters-FF8000?style=flat-square&logo=reuters&logoColor=white" alt="Reuters">
<img src="https://img.shields.io/badge/BBC-B80000?style=flat-square&logo=bbc&logoColor=white" alt="BBC">
<img src="https://img.shields.io/badge/Binance-F0B90B?style=flat-square&logo=binance&logoColor=black" alt="Binance">
<img src="https://img.shields.io/badge/Coinbase-0052FF?style=flat-square&logo=coinbase&logoColor=white" alt="Coinbase">
<img src="https://img.shields.io/badge/Yahoo%20Finance-6001D2?style=flat-square&logo=yahoo&logoColor=white" alt="Yahoo Finance">
<img src="https://img.shields.io/badge/HuggingFace-FFD21F?style=flat-square&logo=huggingface&logoColor=black" alt="HuggingFace">
</p>

<p align="center">
<strong>Agent / IDE / Coding Surfaces</strong><br>
<img src="https://img.shields.io/badge/Claude%20Code-D97757?style=flat-square&logo=anthropic&logoColor=white" alt="Claude Code">
<img src="https://img.shields.io/badge/Codex-111111?style=flat-square&logo=openai&logoColor=white" alt="Codex">
<img src="https://img.shields.io/badge/OpenCode-101010?style=flat-square&logoColor=white" alt="OpenCode">
<img src="https://img.shields.io/badge/Cursor-000000?style=flat-square&logoColor=white" alt="Cursor">
<img src="https://img.shields.io/badge/Kiro-FF9900?style=flat-square&logo=amazon&logoColor=black" alt="Kiro">
<img src="https://img.shields.io/badge/Gemini-4285F4?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini">
<img src="https://img.shields.io/badge/Qwen-1E88E5?style=flat-square&logoColor=white" alt="Qwen">
<img src="https://img.shields.io/badge/Kimi-6C5CE7?style=flat-square&logoColor=white" alt="Kimi">
<img src="https://img.shields.io/badge/MiniMax-00A6FB?style=flat-square&logoColor=white" alt="MiniMax">
<img src="https://img.shields.io/badge/Cline-6E56CF?style=flat-square&logoColor=white" alt="Cline">
<img src="https://img.shields.io/badge/Roo%20Code-2E7D32?style=flat-square&logoColor=white" alt="Roo Code">
<img src="https://img.shields.io/badge/Windsurf-00C2FF?style=flat-square&logoColor=white" alt="Windsurf">
<img src="https://img.shields.io/badge/Continue-000000?style=flat-square&logoColor=white" alt="Continue">
<img src="https://img.shields.io/badge/Aider-6F42C1?style=flat-square&logo=python&logoColor=white" alt="Aider">
<img src="https://img.shields.io/badge/Goose-111827?style=flat-square&logoColor=white" alt="Goose">
<img src="https://img.shields.io/badge/OpenHands-FF6B00?style=flat-square&logoColor=white" alt="OpenHands">
<img src="https://img.shields.io/badge/SWE--agent-0F172A?style=flat-square&logoColor=white" alt="SWE-agent">
<img src="https://img.shields.io/badge/GitHub%20Copilot-181717?style=flat-square&logo=githubcopilot&logoColor=white" alt="GitHub Copilot">
<img src="https://img.shields.io/badge/Amp-5B5BD6?style=flat-square&logoColor=white" alt="Amp">
<img src="https://img.shields.io/badge/Auggie-0EA5E9?style=flat-square&logoColor=white" alt="Auggie">
<img src="https://img.shields.io/badge/Crush-E11D48?style=flat-square&logoColor=white" alt="Crush">
<img src="https://img.shields.io/badge/AgentAPI-334155?style=flat-square&logoColor=white" alt="AgentAPI">
<img src="https://img.shields.io/badge/acpx-475569?style=flat-square&logoColor=white" alt="acpx">
</p>

<p align="center">
<strong>Desktop / Media / DevOps / Cloud</strong><br>
<img src="https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS">
<img src="https://img.shields.io/badge/Chrome-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome">
<img src="https://img.shields.io/badge/Blender-F5792A?style=flat-square&logo=blender&logoColor=white" alt="Blender">
<img src="https://img.shields.io/badge/ffmpeg-007808?style=flat-square&logo=ffmpeg&logoColor=white" alt="ffmpeg">
<img src="https://img.shields.io/badge/ImageMagick-0074C1?style=flat-square&logoColor=white" alt="ImageMagick">
<img src="https://img.shields.io/badge/GIMP-5C5543?style=flat-square&logo=gimp&logoColor=white" alt="GIMP">
<img src="https://img.shields.io/badge/FreeCAD-729FCF?style=flat-square&logo=freecad&logoColor=white" alt="FreeCAD">
<img src="https://img.shields.io/badge/Audacity-0000CC?style=flat-square&logo=audacity&logoColor=white" alt="Audacity">
<img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
<img src="https://img.shields.io/badge/GitHub%20CLI-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub CLI">
<img src="https://img.shields.io/badge/jq-C7254E?style=flat-square&logo=json&logoColor=white" alt="jq">
<img src="https://img.shields.io/badge/yt--dlp-4A5568?style=flat-square&logo=youtube&logoColor=white" alt="yt-dlp">
<img src="https://img.shields.io/badge/AWS-232F3E?style=flat-square&logo=amazonaws&logoColor=white" alt="AWS">
<img src="https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white" alt="Vercel">
<img src="https://img.shields.io/badge/Supabase-3ECF8E?style=flat-square&logo=supabase&logoColor=black" alt="Supabase">
<img src="https://img.shields.io/badge/Cloudflare-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare">
<img src="https://img.shields.io/badge/Stripe-635BFF?style=flat-square&logo=stripe&logoColor=white" alt="Stripe">
<img src="https://img.shields.io/badge/Firebase-FFCA28?style=flat-square&logo=firebase&logoColor=black" alt="Firebase">
<img src="https://img.shields.io/badge/Netlify-00C7B7?style=flat-square&logo=netlify&logoColor=white" alt="Netlify">
<img src="https://img.shields.io/badge/Railway-0B0D0E?style=flat-square&logo=railway&logoColor=white" alt="Railway">
<img src="https://img.shields.io/badge/Azure-0078D4?style=flat-square&logo=microsoftazure&logoColor=white" alt="Azure">
<img src="https://img.shields.io/badge/Google%20Cloud-4285F4?style=flat-square&logo=googlecloud&logoColor=white" alt="Google Cloud">
<img src="https://img.shields.io/badge/Twilio-F22F46?style=flat-square&logo=twilio&logoColor=white" alt="Twilio">
<img src="https://img.shields.io/badge/Resend-000000?style=flat-square&logo=resend&logoColor=white" alt="Resend">
<img src="https://img.shields.io/badge/Algolia-003DFF?style=flat-square&logo=algolia&logoColor=white" alt="Algolia">
<img src="https://img.shields.io/badge/Slack-4A154B?style=flat-square&logo=slack&logoColor=white" alt="Slack">
<img src="https://img.shields.io/badge/Notion-000000?style=flat-square&logo=notion&logoColor=white" alt="Notion">
<img src="https://img.shields.io/badge/Linear-5E6AD2?style=flat-square&logo=linear&logoColor=white" alt="Linear">
<img src="https://img.shields.io/badge/Figma-F24E1E?style=flat-square&logo=figma&logoColor=white" alt="Figma">
</p>

<table>
  <tr>
    <td><strong>给人用</strong><br>装一个二进制，就能从终端调用网站、桌面应用、外部 CLI 和系统动作。</td>
    <td><strong>给 Agent 用</strong><br>先搜任务，再跑一条命令，解析一个 envelope；网站变了就按错误信息修 YAML。</td>
    <td><strong>给维护者用</strong><br>适配器保持小、可读、可测试，用户修复落在 <code>~/.unicli/adapters/</code>。</td>
  </tr>
</table>

<br>

<img src="docs/demo/demo.svg" alt="Uni-CLI 30 秒演示" width="720">

</div>

---

## 🤖 让 Agent 帮你配置

把下面这段扔给你的 agent，然后去倒杯水：

```
帮我配置 unicli——它能给 AI Agent 提供 220 个站点的 CLI 访问权限，支持自修复适配器：
  1. npm install -g @zenalexa/unicli
  2. 添加 MCP：claude mcp add unicli -- npx @zenalexa/unicli mcp serve
  3. 验证：unicli hackernews top -f json
```

Agent 自己会搞定。回来的时候，220 个站点都在 CLI 里等着你了。

**各平台一行配置：**

| 平台                         | 配置方式                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Claude Code**              | `claude mcp add unicli -- npx @zenalexa/unicli mcp serve`                                            |
| **Codex CLI**                | 在 `~/.codex/config.toml` 添加 `[mcp_servers.unicli]` · `command = "npx @zenalexa/unicli mcp serve"` |
| **Cursor / Windsurf**        | MCP 设置 → 添加服务器 → `npx @zenalexa/unicli mcp serve`                                             |
| **avante.nvim / Zed**        | `unicli acp` — ACP 兼容入口；核心执行优先走 CLI/JSON/MCP                                             |
| **OpenCode**                 | 在 `opencode.jsonc` 中添加 `"command": "unicli mcp serve"`                                           |
| **Kiro / Cline / Roo**       | 作为 MCP server 接入 Uni-CLI；编辑器继续拥有 session                                                 |
| **任何有 Bash 权限的 Agent** | 直接运行 `unicli <站点> <命令>` — 零配置                                                             |

---

## 是什么

Uni-CLI 是专为 AI Agent 设计的通用命令行界面——单个二进制文件，将 Agent 意图编译为可确定性执行的程序，覆盖 <!-- STATS:site_count -->220<!-- /STATS --> 个站点、30+ 桌面应用、58 个 CLI 桥接和本地操作系统（共 <!-- STATS:command_count -->1283<!-- /STATS --> 条命令）。每个适配器约 20 行 YAML：Agent 可读、可编辑、零构建步骤。站点修改 API 时，Agent 编辑 YAML，保存到 `~/.unicli/adapters/`，重试即可。修复永久生效，`npm update` 也不会覆盖。全程无需人工介入。

覆盖范围贯穿各个层面：HTTP Web API、CDP 浏览器自动化、桌面子进程（ffmpeg、Blender、LibreOffice）、macOS 系统调用（截屏、日历、剪贴板）、macOS AX，以及可插拔 CUA 合同。Windows UIA、Linux AT-SPI 和第三方 CUA provider 当前是显式声明的能力边界/接口桩，不按已完成实执行能力宣传；全部通过统一的 `unicli <站点> <命令>` 接口访问。

## 为什么 CLI 比 MCP 强

大型工具目录会让 Agent 在行动之前先付上下文成本：描述、schema、示例、认证说明和边界条件都会挤占任务上下文。Uni-CLI 默认不把完整目录塞进上下文；Agent 先按意图搜索，拿到一条可执行命令，再收到一个足够小、足够结构化、可重试也可修复的 v2 envelope。

当前 Agent 栈没有收敛到单一 runtime。真实可复用的形态是 native CLI、JSON stream、MCP 工具总线、编辑器持有 session、桥接控制面和 watchlist runtime 混合存在。Uni-CLI 不硬编码赢家，而是把它们都当作路由：优先 CLI/JSON/MCP，编辑器 gateway 只放在真正需要兼容的边界。

| 接口                          | 冷启动开销     | 单次命令成本                                | 自修复 |
| ----------------------------- | -------------- | ------------------------------------------- | ------ |
| 典型 MCP 服务器（93 工具）    | ~55,000 token  | ~500–2,000 token                            | 否     |
| **Uni-CLI MCP**（4 个元工具） | **~200 token** | 见 [`docs/BENCHMARK.md`](docs/BENCHMARK.md) | **是** |
| **Uni-CLI via Bash**          | **0 token**    | 见 [`docs/BENCHMARK.md`](docs/BENCHMARK.md) | **是** |

Uni-CLI 的 MCP 服务器只暴露四个元工具（`unicli_run`、`unicli_list`、`unicli_search`、`unicli_explore`），Agent 通过 BM25 中英双语搜索在 50KB 索引中按需拉取精确命令。直接 Bash 调用没有工具目录 token，只是一次确定性的子进程执行。可复现的本地数据（p50/p95，token + latency）：[`docs/BENCHMARK.md`](docs/BENCHMARK.md)。

## 快速开始

```bash
# 安装
npm install -g @zenalexa/unicli

# 发现命令（中英双语）
unicli list                          # 所有站点 + 命令
unicli search "微博热搜"              # → weibo trending
unicli search "B站热门"              # → bilibili popular
unicli search "download video"       # → bilibili download, yt-dlp

# 运行
unicli weibo trending --limit 10     # 微博热搜，零配置
unicli zhihu hot -f json             # 知乎热榜，JSON envelope
unicli bilibili popular --limit 5    # B 站热门视频
unicli hackernews top -f json | jq '.data[].title'  # 管道 + 变换

# 接入 Agent
claude mcp add unicli -- npx @zenalexa/unicli mcp serve   # Claude Code
unicli mcp serve --transport streamable --port 19826      # 任意 MCP 客户端
unicli acp                                                # avante.nvim / Zed
```

完整指南（含 5 个实例）：[`docs/QUICKSTART.md`](docs/QUICKSTART.md)。

## 自修复

自修复是 Uni-CLI 作为基础设施而非普通工具的核心能力。当站点修改 API：

```
unicli <站点> <命令> 失败
  → stderr: { "adapter_path": "~/.unicli/adapters/weibo/trending.yaml",
               "step": "fetch", "action": "GET /api/v4/search/top",
               "suggestion": "endpoint 可能已版本化为 /api/v4/search/trending" }
  → Agent 打开 adapter_path 处的 ~20 行 YAML
  → Agent 修改选择器 / 端点 / 认证头
  → unicli <站点> <命令> 成功
  → 修复保存到 ~/.unicli/adapters/ — 永久生效，npm update 不覆盖
```

这是 Banach 收敛设计：每条错误消息都提供方向性反馈（`adapter_path` + `step` + `suggestion`），使连续修复迭代收敛到可用状态。Agent 积累的修复不会被重置。

```bash
unicli repair weibo trending    # 诊断 + 建议修复方案
unicli test weibo               # 验证站点所有适配器
unicli repair --loop            # 自主修复循环（Agent 驱动）
```

退出码遵循 `sysexits.h`：`0` 成功 · `66` 空结果 · `69` 不可用 · `75` 临时错误 · `77` 认证 · `78` 配置。

## 架构

七个传输层，一个适配器接口，一个输出格式化器。

| 传输层             | 覆盖范围                                                          |
| ------------------ | ----------------------------------------------------------------- |
| **HTTP**           | Web API — REST、RSS、JSON、GraphQL                                |
| **CDP 浏览器**     | 通过真实 Chrome 会话访问任意站点（13 层反检测隐身，复用登录状态） |
| **子进程**         | ffmpeg、yt-dlp、gh、aws、docker、stripe 等 30+ 工具               |
| **Desktop-AX**     | macOS — AppleScript、Accessibility API、快捷指令、日历、邮件      |
| **Desktop-UIA**    | Windows — 声明式接口桩，尚不按实执行能力宣传                      |
| **Desktop-AT-SPI** | Linux — 声明式接口桩，尚不按实执行能力宣传                        |
| **CUA**            | screenshot/action 合同、mock 后端、provider 接口桩                |

适配器默认使用声明式 YAML（Rice 可判定性——无图灵完备逻辑，可证明终止）。流水线有 <!-- STATS:pipeline_step_count -->59<!-- /STATS -->+ 个步骤：`fetch`、`navigate`、`exec`、`extract`、`each`、`if`、`parallel`、`rate_limit`、`retry` 等。完整文档：[`docs/ADAPTER-FORMAT.md`](docs/ADAPTER-FORMAT.md)。

## 功能矩阵

| 能力               | 详情                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| **CUA 合同**       | 稳定 screenshot/action 接口、mock 后端和显式 provider 桩；尚不按真实 computer-use 宣传        |
| **MCP 传输**       | stdio · Streamable HTTP（规范 2025-11-25）· SSE · OAuth 2.1 PKCE                              |
| **Agent 后端矩阵** | `unicli agents matrix/recommend`：覆盖 native CLI、JSON stream、MCP、桥接、编辑器和 watchlist |
| **ACP Gateway**    | `unicli acp` — 保留 avante.nvim/Zed 兼容入口，不作为核心 runtime                              |
| **跨厂商 Skills**  | Claude Code · OpenCode · Codex CLI · Cursor · Windsurf · Cline                                |
| **自修复**         | 每条 stderr 错误携带 `adapter_path` + `step` + `suggestion`（Banach 收敛）                    |
| **中英双语搜索**   | BM25 + TF-IDF · 50KB 索引 · <10ms · 200 条 ZH↔EN 别名表                                       |
| **浏览器守护进程** | 持久化 Chrome（CDP）· 复用登录状态 · 13 层反检测隐身                                          |
| **输出格式**       | 终端表格 · JSON（管道自动切换）· YAML · CSV · Markdown                                        |
| **认证策略**       | public · cookie · CSRF header · browser intercept · UI 自动化 — 自动级联探测                  |

## 平台覆盖

<!-- STATS:site_count -->220<!-- /STATS --> 个站点 · <!-- STATS:command_count -->1283<!-- /STATS --> 条命令 — 完整实时列表见 [`AGENTS.md`](AGENTS.md)：

| 领域                | 代表站点                                                             |
| ------------------- | -------------------------------------------------------------------- |
| **社交媒体 (25)**   | 微博 · 知乎 · 哔哩哔哩 · 小红书 · 推特 · Reddit · Instagram · TikTok |
| **科技社区 (19)**   | Hacker News · Stack Overflow · GitHub Trending · npm · PyPI          |
| **资讯新闻 (11)**   | BBC · Reuters · Bloomberg · 36kr · 纽约时报 · TechCrunch             |
| **金融财经 (8)**    | 雪球 · 东方财富 · Yahoo Finance · 币安 · Coinbase                    |
| **AI / ML (14)**    | HuggingFace · 魔搭 · Ollama · Replicate · DeepSeek · 豆包            |
| **桌面软件 (30+)**  | Blender · ffmpeg · ImageMagick · GIMP · FreeCAD · LibreOffice        |
| **macOS 系统 (58)** | 截屏 · 剪贴板 · 日历 · 邮件 · 提醒事项 · 快捷指令 · Safari           |
| **CLI 桥接 (58)**   | claude · codex · gemini · qwen · kiro · opencode · aider · goose     |

`unicli list` 查看完整列表 · `unicli list --category=<领域>` 按类别筛选。

## 认证

五种策略，自动级联探测（`public → cookie → header → intercept → ui`）：

| 策略        | 方式                                       |
| ----------- | ------------------------------------------ |
| `public`    | 直接 HTTP，无需凭证                        |
| `cookie`    | `~/.unicli/cookies/<站点>.json` 注入请求头 |
| `header`    | Cookie + 自动提取 CSRF（ct0、bili_jct 等） |
| `intercept` | Chrome 导航，Uni-CLI 捕获 XHR/fetch 响应   |
| `ui`        | 通过 CDP 直接操作 DOM（点击、输入、提交）  |

```bash
unicli auth setup weibo     # 打印所需 cookie 和保存路径
unicli auth check weibo     # 验证 cookie 文件
unicli auth list            # 所有已配置站点
```

浏览器守护进程（`unicli browser start`）通过 CDP 复用已登录的 Chrome 会话——无需导出 cookie，无需安装扩展。4 小时无操作后自动退出。

## 写一个适配器

约 20 行 YAML，零 TypeScript，零构建步骤，Agent 可直接读写：

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
  - map:
      title: "${{ item.title }}"
      score: "${{ item.score }}"
      url: "${{ item.url }}"
columns: [title, score, url]
```

五种适配器类型：`web-api` · `desktop` · `browser` · `bridge` · `service`。29 个模板过滤器在沙箱 VM 中运行。

```bash
unicli init <站点> <命令>    # 生成脚手架
unicli dev <路径>            # 热重载开发
unicli test <站点>           # 验证适配器
unicli record <URL>          # 从网络流量自动生成适配器
```

完整文档：[`docs/ADAPTER-FORMAT.md`](docs/ADAPTER-FORMAT.md)。

## 搜索

按意图发现命令，中英双语：

```bash
unicli search "微博热搜"              # → weibo trending
unicli search "B站热门"              # → bilibili popular
unicli search "推特热门"              # → twitter trending
unicli search "股票行情"              # → binance ticker, xueqiu quote
unicli search "download video"       # 英文查询 → 多平台下载命令
unicli search --category finance     # 按类别浏览
```

BM25 + TF-IDF · 200 条 ZH↔EN 别名表 · 50KB 索引 · <10ms 查询。

## 理论基础

五条可执行的设计原则：

1. **Rice 限制** — 可判定的适配器语义（YAML 流水线，无图灵完备逻辑，可证明终止）
2. **Lehman 命令** — 自修复是一等公民；没有永久有效的适配器；每个站点终将改变
3. **Shannon 压缩** — `unicli` 调用是底层 API 调用的近最优压缩（约 80 token）
4. **Agent 工具三难困境**（原创贡献）— 覆盖率 × 准确率 × 性能，三选二。我们优化准确率 × 性能
5. **Banach 收敛** — 结构化错误消息（`adapter_path` + `step` + `suggestion`）保证修复迭代收敛

完整论述：[`docs/THEORY.md`](docs/THEORY.md)。可复现的本地基准测试：[`docs/BENCHMARK.md`](docs/BENCHMARK.md)。

## 开发

```bash
git clone https://github.com/olo-dot-io/Uni-CLI.git && cd Uni-CLI
npm install
npm run verify    # 类型检查 + lint + 测试 + 构建（7 个关卡，发布前必须全通过）
```

| 命令                   | 用途                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `npm run dev`          | 从源码运行（tsx）                                           |
| `npm run build`        | 生产构建                                                    |
| `npm run typecheck`    | TypeScript 严格模式                                         |
| `npm run lint`         | Oxlint                                                      |
| `npm run test`         | 单元测试（<!-- STATS:test_count -->7160<!-- /STATS --> 个） |
| `npm run test:adapter` | 验证所有适配器                                              |
| `npm run verify`       | 完整流水线 — 发布前必须通过                                 |

十一个生产依赖：`ajv` · `ajv-formats` · `chalk` · `cli-table3` · `commander` · `js-yaml` · `jsonpath-plus` · `turndown` · `undici` · `ws` · `zod`。

## 发布节奏

补丁版本每周 **周五 09:00 HKT** 发布——前提是自上次打 tag 以来有实质性提交。平静的一周会被记录并跳过——沉默不是失败，而是成功。Dependabot 升级每周一合成一个 PR，在周五的版本里搭车一起上，避免污染提交历史。

<a href="https://github.com/olo-dot-io/Uni-CLI/commits/main"><img src="https://img.shields.io/github/last-commit/olo-dot-io/Uni-CLI?style=flat-square&label=last-commit" alt="最近提交"></a>

完整策略——手动覆写、取消流程、升级规则：[`docs/RELEASE-CADENCE.md`](docs/RELEASE-CADENCE.md)。

## 贡献

最快合并的方式：为你每天使用的站点写一个 20 行 YAML 适配器。评审门槛很低——只要能跑、符合 schema，就能合并。

| 领域       | 指南                                                     |
| ---------- | -------------------------------------------------------- |
| 新适配器   | [`contributing/adapter.md`](contributing/adapter.md)     |
| 新传输层   | [`contributing/transport.md`](contributing/transport.md) |
| CUA 后端   | [`contributing/cua.md`](contributing/cua.md)             |
| MCP 服务器 | [`contributing/mcp.md`](contributing/mcp.md)             |
| ACP 集成   | [`contributing/acp.md`](contributing/acp.md)             |
| 发布流程   | [`contributing/release.md`](contributing/release.md)     |

## 许可证

[Apache-2.0](./LICENSE)

仓库：<https://github.com/olo-dot-io/Uni-CLI> · npm：[`@zenalexa/unicli`](https://www.npmjs.com/package/@zenalexa/unicli) · 欢迎提 Issue。

---

<p align="center">
  <a href="https://github.com/olo-dot-io/Uni-CLI/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=olo-dot-io/Uni-CLI" alt="贡献者">
  </a>
</p>

<p align="center">
  <sub>v0.215.1</sub>
</p>
