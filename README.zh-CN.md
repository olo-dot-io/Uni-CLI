<p align="center">
  <img src="assets/mascot-otter.png" alt="Uni-CLI 水獭 mascot" width="180">
</p>

<h1 align="center">Uni-CLI</h1>

<p align="center">
  <strong>面向真实软件的 Agent 执行底座。</strong>
</p>

<p align="center">
  <a href="https://olo-dot-io.github.io/Uni-CLI/">文档站</a>
  ·
  <a href="https://olo-dot-io.github.io/Uni-CLI/reference/sites">站点目录</a>
  ·
  <a href="https://olo-dot-io.github.io/Uni-CLI/llms.txt">llms.txt</a>
</p>

<p align="center">
  按意图发现命令，跨 Web、应用、本地工具和系统能力执行可治理操作，再返回带证据的 AgentEnvelope，方便智能体检查和修复。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@zenalexa/unicli"><img alt="npm" src="https://img.shields.io/npm/v/@zenalexa/unicli?style=flat-square"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-20%2B-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-2025--11--25-6f42c1?style=flat-square">
</p>

<p align="center">
  <sub><!-- STATS:site_count -->282<!-- /STATS --> 个站点 · <!-- STATS:command_count -->1680<!-- /STATS --> 条命令 · <!-- STATS:pipeline_step_count -->101<!-- /STATS --> 个 pipeline step · <!-- STATS:test_count -->8393<!-- /STATS --> 个测试</sub>
</p>

## 30 秒开始

```bash
npm install -g @zenalexa/unicli
unicli search "微博热搜"
unicli hackernews top --limit 5 -f json
npx @zenalexa/unicli mcp serve
```

| 目标              | 命令                                                   |
| ----------------- | ------------------------------------------------------ |
| 按意图找能力      | `unicli search "总结 reddit 讨论"`                     |
| 查看已安装覆盖    | `unicli list`, `unicli list --site macos`              |
| 用机器契约执行    | `unicli <site> <command> -f json`                      |
| 下载并读取论文    | `unicli arxiv download <id> && unicli pdf read <file>` |
| 查 ACG/tag 内容   | `unicli search "花火 星穹铁道 character"`              |
| 本地修复 adapter  | `unicli repair <site> <command>`                       |
| 给 Agent 暴露工具 | `npx @zenalexa/unicli mcp serve --expanded`            |

<!-- IF YOU ARE AN AI AGENT: Start here.
Install: npm install -g @zenalexa/unicli
Discover: unicli search "your intent"
Run: unicli <site> <command> [args] [-f json|md|yaml|csv|compact]
Repair: read the error envelope, edit the adapter_path, run unicli repair <site> <command>
Prefer native CLI / JSON stream / MCP for agent runtimes. Use ACP as an editor compatibility gateway.
-->

## 它解决什么

Uni-CLI 位于 Agent 应用之下，把软件表面收敛成 Agent 能发现、能执行、能记录、能修的命令。

| 表面         | 能力                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 网站和 API   | public、cookie、header、browser-intercept 等 adapter                                                                                                                       |
| 浏览器自动化 | CDP 的 navigate、click、type、intercept、snapshot、extract、wait 等步骤                                                                                                    |
| 桌面和 macOS | 系统命令、App adapter、实时 Shortcuts/App Intent 发现、截图、剪贴板、日历、亮度、本地工具                                                                                  |
| 外部 CLI     | 58 个已登记的 passthrough bridge，支持安装和状态发现                                                                                                                       |
| Agent 后端   | native CLI、JSON stream、MCP、ACP、HTTP API、OpenAI-compatible、bridge 路由矩阵                                                                                            |
| 操作策略     | `open`、`confirm`、`locked` profile，暴露 effect/risk scope、本地 deny 规则、`--yes` 和持久审批记忆                                                                        |
| 执行证据     | run trace 会记录环境快照，也能 probe/replay/compare 打分并输出结构化 gate 结果；浏览器 session lease 带 tab/auth 姿态，还支持 render-aware 证据、移动检测和 stale-ref 细节 |
| 输出         | v2 `AgentEnvelope`，支持 Markdown、JSON、YAML、CSV、compact                                                                                                                |
| 修复         | 错误里带 `adapter_path`、失败 `step`、是否可重试、修复建议和替代命令                                                                                                       |

## 给 Agent 的入口

先搜索，再执行最小可用命令。

```bash
unicli search "推特热门" --limit 5
unicli twitter search "coding agents" -f json
unicli anilist characters "Sparkle" --limit 5 -f json
unicli danbooru tags sparkle --limit 5 -f json
unicli arxiv download 1706.03762 --output ./papers -f json
unicli pdf read ./papers/1706.03762.pdf --first_page 1 --last_page 3 -f json
unicli macos app-actions --app WhatsApp -f json
unicli macos automation-smoke -f json
unicli repair twitter search
```

非 TTY 和 Agent 环境默认输出结构化 Markdown。需要机器格式时显式指定：

```bash
UNICLI_OUTPUT=json unicli reddit hot --limit 10
unicli hackernews top --limit 5 -f yaml
unicli --record --permission-profile confirm twitter search "coding agents" -f json
unicli runs list -f json
unicli runs show <run_id> -f json
unicli runs probe <run_id> -f json
unicli runs replay <run_id> --permission-profile confirm --yes --min-score 1 --min-context-score 1 --min-overall-score 1 -f json
unicli runs compare <run_id> <replay_run_id> -f json
unicli runs compare <run_id> <replay_run_id> --min-score 1 --min-context-score 1 --min-overall-score 1 -f json
unicli --permission-profile locked --yes --remember-approval word set-font "Inter"
unicli approvals list -f json
unicli approvals revoke <approval_key> -f json
unicli browser evidence --render-aware --expect-domain example.com -f json
```

协议入口：

```bash
npx @zenalexa/unicli mcp serve
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
unicli acp
unicli agents recommend codex
unicli agents matrix
```

ACP 作为编辑器和桥接兼容层保留。真正跑任务时，优先 native CLI、JSON stream 或 MCP。

## 覆盖范围

每条命令都能搜索、可声明、可验证、可修。近期覆盖已经扩展到论文下载和本地 PDF 读取、ACG/动画/漫画/wiki 发现、booru tag 搜索、美少女游戏目录，以及日文和罗马音实体检索。

下面的网格由 active manifest 中带真实 logo 的站点生成，徽章命令数不包含 quarantined 命令。完整目录始终以 `unicli list` 和文档站为准。

<!-- BEGIN README_SITE_GRID -->
<div align="center">
<p><strong>社交</strong><br>
  <a data-site="band" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="band: 4 commands"><img alt="band" src="https://img.shields.io/static/v1?label=band&message=4+cmds&color=2563eb&style=flat-square&logo=bandlab&logoColor=white"></a>
  <a data-site="bluesky" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="bluesky: 12 commands"><img alt="bluesky" src="https://img.shields.io/static/v1?label=bluesky&message=12+cmds&color=2563eb&style=flat-square&logo=bluesky&logoColor=white"></a>
  <a data-site="dingtalk" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="dingtalk: 8 commands"><img alt="dingtalk" src="https://img.shields.io/static/v1?label=dingtalk&message=8+cmds&color=2563eb&style=flat-square&logo=dingtalk&logoColor=white"></a>
  <a data-site="discord-app" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="discord-app: 15 commands"><img alt="discord-app" src="https://img.shields.io/static/v1?label=discord-app&message=15+cmds&color=2563eb&style=flat-square&logo=discord&logoColor=white"></a>
  <a data-site="douban" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="douban: 9 commands"><img alt="douban" src="https://img.shields.io/static/v1?label=douban&message=9+cmds&color=2563eb&style=flat-square&logo=douban&logoColor=white"></a>
  <a data-site="instagram" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="instagram: 28 commands"><img alt="instagram" src="https://img.shields.io/static/v1?label=instagram&message=28+cmds&color=2563eb&style=flat-square&logo=instagram&logoColor=white"></a>
  <a data-site="lark" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="lark: 8 commands"><img alt="lark" src="https://img.shields.io/static/v1?label=lark&message=8+cmds&color=2563eb&style=flat-square&logo=lark&logoColor=white"></a>
  <a data-site="mastodon" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="mastodon: 3 commands"><img alt="mastodon" src="https://img.shields.io/static/v1?label=mastodon&message=3+cmds&color=2563eb&style=flat-square&logo=mastodon&logoColor=white"></a>
  <a data-site="reddit" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="reddit: 24 commands"><img alt="reddit" src="https://img.shields.io/static/v1?label=reddit&message=24+cmds&color=2563eb&style=flat-square&logo=reddit&logoColor=white"></a>
  <a data-site="signal" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="signal: 7 commands"><img alt="signal" src="https://img.shields.io/static/v1?label=signal&message=7+cmds&color=2563eb&style=flat-square&logo=signal&logoColor=white"></a>
  <a data-site="slack" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="slack: 14 commands"><img alt="slack" src="https://img.shields.io/static/v1?label=slack&message=14+cmds&color=2563eb&style=flat-square&logo=slack&logoColor=white"></a>
  <a data-site="teams" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="teams: 7 commands"><img alt="teams" src="https://img.shields.io/static/v1?label=teams&message=7+cmds&color=2563eb&style=flat-square&logo=microsoftteams&logoColor=white"></a>
  <a data-site="twitter" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="twitter: 44 commands"><img alt="twitter" src="https://img.shields.io/static/v1?label=twitter&message=44+cmds&color=2563eb&style=flat-square&logo=x&logoColor=white"></a>
  <a data-site="wechat-work" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="wechat-work: 7 commands"><img alt="wechat-work" src="https://img.shields.io/static/v1?label=wechat-work&message=7+cmds&color=2563eb&style=flat-square&logo=wechat&logoColor=white"></a>
  <a data-site="weibo" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="weibo: 12 commands"><img alt="weibo" src="https://img.shields.io/static/v1?label=weibo&message=12+cmds&color=2563eb&style=flat-square&logo=sinaweibo&logoColor=white"></a>
  <a data-site="whatsapp" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="whatsapp: 7 commands"><img alt="whatsapp" src="https://img.shields.io/static/v1?label=whatsapp&message=7+cmds&color=2563eb&style=flat-square&logo=whatsapp&logoColor=white"></a>
  <a data-site="xiaohongshu" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="xiaohongshu: 22 commands"><img alt="xiaohongshu" src="https://img.shields.io/static/v1?label=xiaohongshu&message=22+cmds&color=2563eb&style=flat-square&logo=xiaohongshu&logoColor=white"></a>
  <a data-site="zhihu" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="zhihu: 25 commands"><img alt="zhihu" src="https://img.shields.io/static/v1?label=zhihu&message=25+cmds&color=2563eb&style=flat-square&logo=zhihu&logoColor=white"></a>
  <a data-site="zoom-app" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="zoom-app: 7 commands"><img alt="zoom-app" src="https://img.shields.io/static/v1?label=zoom-app&message=7+cmds&color=2563eb&style=flat-square&logo=zoom&logoColor=white"></a>
</p>
<p><strong>视频</strong><br>
  <a data-site="bilibili" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="bilibili: 14 commands"><img alt="bilibili" src="https://img.shields.io/static/v1?label=bilibili&message=14+cmds&color=dc2626&style=flat-square&logo=bilibili&logoColor=white"></a>
  <a data-site="douyin" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="douyin: 13 commands"><img alt="douyin" src="https://img.shields.io/static/v1?label=douyin&message=13+cmds&color=dc2626&style=flat-square&logo=tiktok&logoColor=white"></a>
  <a data-site="tiktok" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="tiktok: 17 commands"><img alt="tiktok" src="https://img.shields.io/static/v1?label=tiktok&message=17+cmds&color=dc2626&style=flat-square&logo=tiktok&logoColor=white"></a>
  <a data-site="twitch" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="twitch: 4 commands"><img alt="twitch" src="https://img.shields.io/static/v1?label=twitch&message=4+cmds&color=dc2626&style=flat-square&logo=twitch&logoColor=white"></a>
  <a data-site="youtube" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="youtube: 16 commands"><img alt="youtube" src="https://img.shields.io/static/v1?label=youtube&message=16+cmds&color=dc2626&style=flat-square&logo=youtube&logoColor=white"></a>
</p>
<p><strong>新闻</strong><br>
  <a data-site="bbc" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="bbc: 5 commands"><img alt="bbc" src="https://img.shields.io/static/v1?label=bbc&message=5+cmds&color=b45309&style=flat-square&logo=bbc&logoColor=white"></a>
  <a data-site="bloomberg" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="bloomberg: 10 commands"><img alt="bloomberg" src="https://img.shields.io/static/v1?label=bloomberg&message=10+cmds&color=b45309&style=flat-square&logo=bloomberg&logoColor=white"></a>
  <a data-site="cnn" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="cnn: 2 commands"><img alt="cnn" src="https://img.shields.io/static/v1?label=cnn&message=2+cmds&color=b45309&style=flat-square&logo=cnn&logoColor=white"></a>
  <a data-site="hackernews" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="hackernews: 11 commands"><img alt="hackernews" src="https://img.shields.io/static/v1?label=hackernews&message=11+cmds&color=b45309&style=flat-square&logo=ycombinator&logoColor=white"></a>
  <a data-site="nytimes" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="nytimes: 2 commands"><img alt="nytimes" src="https://img.shields.io/static/v1?label=nytimes&message=2+cmds&color=b45309&style=flat-square&logo=newyorktimes&logoColor=white"></a>
  <a data-site="reuters" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="reuters: 3 commands"><img alt="reuters" src="https://img.shields.io/static/v1?label=reuters&message=3+cmds&color=b45309&style=flat-square&logo=reuters&logoColor=white"></a>
</p>
<p><strong>财经</strong><br>
  <a data-site="barchart" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="barchart: 4 commands"><img alt="barchart" src="https://img.shields.io/static/v1?label=barchart&message=4+cmds&color=047857&style=flat-square&logo=chartdotjs&logoColor=white"></a>
  <a data-site="binance" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="binance: 13 commands"><img alt="binance" src="https://img.shields.io/static/v1?label=binance&message=13+cmds&color=047857&style=flat-square&logo=binance&logoColor=white"></a>
  <a data-site="coinbase" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="coinbase: 2 commands"><img alt="coinbase" src="https://img.shields.io/static/v1?label=coinbase&message=2+cmds&color=047857&style=flat-square&logo=coinbase&logoColor=white"></a>
  <a data-site="yahoo-finance" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="yahoo-finance: 2 commands"><img alt="yahoo-finance" src="https://img.shields.io/static/v1?label=yahoo-finance&message=2+cmds&color=047857&style=flat-square&logo=yahoo&logoColor=white"></a>
</p>
<p><strong>购物</strong><br>
  <a data-site="1688" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="1688: 5 commands"><img alt="1688" src="https://img.shields.io/static/v1?label=1688&message=5+cmds&color=be185d&style=flat-square&logo=alibabadotcom&logoColor=white"></a>
  <a data-site="amazon" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="amazon: 8 commands"><img alt="amazon" src="https://img.shields.io/static/v1?label=amazon&message=8+cmds&color=be185d&style=flat-square&logo=amazon&logoColor=white"></a>
  <a data-site="coupang" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="coupang: 3 commands"><img alt="coupang" src="https://img.shields.io/static/v1?label=coupang&message=3+cmds&color=be185d&style=flat-square&logo=coupang&logoColor=white"></a>
</p>
<p><strong>开发</strong><br>
  <a data-site="claude-code" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="claude-code: 1 command"><img alt="claude-code" src="https://img.shields.io/static/v1?label=claude-code&message=1+cmds&color=4f46e5&style=flat-square&logo=anthropic&logoColor=white"></a>
  <a data-site="cocoapods" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="cocoapods: 2 commands"><img alt="cocoapods" src="https://img.shields.io/static/v1?label=cocoapods&message=2+cmds&color=4f46e5&style=flat-square&logo=cocoapods&logoColor=white"></a>
  <a data-site="codex" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="codex: 18 commands"><img alt="codex" src="https://img.shields.io/static/v1?label=codex&message=18+cmds&color=4f46e5&style=flat-square&logo=openai&logoColor=white"></a>
  <a data-site="codex-cli" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="codex-cli: 1 command"><img alt="codex-cli" src="https://img.shields.io/static/v1?label=codex-cli&message=1+cmds&color=4f46e5&style=flat-square&logo=openai&logoColor=white"></a>
  <a data-site="crates-io" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="crates-io: 3 commands"><img alt="crates-io" src="https://img.shields.io/static/v1?label=crates-io&message=3+cmds&color=4f46e5&style=flat-square&logo=rust&logoColor=white"></a>
  <a data-site="cursor" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="cursor: 18 commands"><img alt="cursor" src="https://img.shields.io/static/v1?label=cursor&message=18+cmds&color=4f46e5&style=flat-square&logo=cursor&logoColor=white"></a>
  <a data-site="docker-desktop" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="docker-desktop: 7 commands"><img alt="docker-desktop" src="https://img.shields.io/static/v1?label=docker-desktop&message=7+cmds&color=4f46e5&style=flat-square&logo=docker&logoColor=white"></a>
  <a data-site="docker-hub" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="docker-hub: 3 commands"><img alt="docker-hub" src="https://img.shields.io/static/v1?label=docker-hub&message=3+cmds&color=4f46e5&style=flat-square&logo=docker&logoColor=white"></a>
  <a data-site="github-desktop" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="github-desktop: 7 commands"><img alt="github-desktop" src="https://img.shields.io/static/v1?label=github-desktop&message=7+cmds&color=4f46e5&style=flat-square&logo=github&logoColor=white"></a>
  <a data-site="github-trending" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="github-trending: 1 command"><img alt="github-trending" src="https://img.shields.io/static/v1?label=github-trending&message=1+cmds&color=4f46e5&style=flat-square&logo=github&logoColor=white"></a>
  <a data-site="gitkraken" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="gitkraken: 7 commands"><img alt="gitkraken" src="https://img.shields.io/static/v1?label=gitkraken&message=7+cmds&color=4f46e5&style=flat-square&logo=gitkraken&logoColor=white"></a>
  <a data-site="gitlab" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="gitlab: 3 commands"><img alt="gitlab" src="https://img.shields.io/static/v1?label=gitlab&message=3+cmds&color=4f46e5&style=flat-square&logo=gitlab&logoColor=white"></a>
  <a data-site="homebrew" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="homebrew: 5 commands"><img alt="homebrew" src="https://img.shields.io/static/v1?label=homebrew&message=5+cmds&color=4f46e5&style=flat-square&logo=homebrew&logoColor=white"></a>
  <a data-site="insomnia" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="insomnia: 7 commands"><img alt="insomnia" src="https://img.shields.io/static/v1?label=insomnia&message=7+cmds&color=4f46e5&style=flat-square&logo=insomnia&logoColor=white"></a>
  <a data-site="maven" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="maven: 3 commands"><img alt="maven" src="https://img.shields.io/static/v1?label=maven&message=3+cmds&color=4f46e5&style=flat-square&logo=apachemaven&logoColor=white"></a>
  <a data-site="npm" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="npm: 5 commands"><img alt="npm" src="https://img.shields.io/static/v1?label=npm&message=5+cmds&color=4f46e5&style=flat-square&logo=npm&logoColor=white"></a>
  <a data-site="npm-trends" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="npm-trends: 2 commands"><img alt="npm-trends" src="https://img.shields.io/static/v1?label=npm-trends&message=2+cmds&color=4f46e5&style=flat-square&logo=npm&logoColor=white"></a>
  <a data-site="nuget" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="nuget: 3 commands"><img alt="nuget" src="https://img.shields.io/static/v1?label=nuget&message=3+cmds&color=4f46e5&style=flat-square&logo=nuget&logoColor=white"></a>
  <a data-site="packagist" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="packagist: 3 commands"><img alt="packagist" src="https://img.shields.io/static/v1?label=packagist&message=3+cmds&color=4f46e5&style=flat-square&logo=packagist&logoColor=white"></a>
  <a data-site="postman" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="postman: 7 commands"><img alt="postman" src="https://img.shields.io/static/v1?label=postman&message=7+cmds&color=4f46e5&style=flat-square&logo=postman&logoColor=white"></a>
  <a data-site="producthunt" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="producthunt: 5 commands"><img alt="producthunt" src="https://img.shields.io/static/v1?label=producthunt&message=5+cmds&color=4f46e5&style=flat-square&logo=producthunt&logoColor=white"></a>
  <a data-site="pub-dev" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="pub-dev: 2 commands"><img alt="pub-dev" src="https://img.shields.io/static/v1?label=pub-dev&message=2+cmds&color=4f46e5&style=flat-square&logo=dart&logoColor=white"></a>
  <a data-site="pypi" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="pypi: 4 commands"><img alt="pypi" src="https://img.shields.io/static/v1?label=pypi&message=4+cmds&color=4f46e5&style=flat-square&logo=pypi&logoColor=white"></a>
  <a data-site="rubygems" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="rubygems: 3 commands"><img alt="rubygems" src="https://img.shields.io/static/v1?label=rubygems&message=3+cmds&color=4f46e5&style=flat-square&logo=rubygems&logoColor=white"></a>
  <a data-site="stackoverflow" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="stackoverflow: 10 commands"><img alt="stackoverflow" src="https://img.shields.io/static/v1?label=stackoverflow&message=10+cmds&color=4f46e5&style=flat-square&logo=stackoverflow&logoColor=white"></a>
  <a data-site="vscode" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="vscode: 10 commands"><img alt="vscode" src="https://img.shields.io/static/v1?label=vscode&message=10+cmds&color=4f46e5&style=flat-square&logo=visualstudiocode&logoColor=white"></a>
</p>
<p><strong>AI</strong><br>
  <a data-site="antigravity" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="antigravity: 16 commands"><img alt="antigravity" src="https://img.shields.io/static/v1?label=antigravity&message=16+cmds&color=7c3aed&style=flat-square&logo=google&logoColor=white"></a>
  <a data-site="chatgpt" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="chatgpt: 17 commands"><img alt="chatgpt" src="https://img.shields.io/static/v1?label=chatgpt&message=17+cmds&color=7c3aed&style=flat-square&logo=openai&logoColor=white"></a>
  <a data-site="claude" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="claude: 14 commands"><img alt="claude" src="https://img.shields.io/static/v1?label=claude&message=14+cmds&color=7c3aed&style=flat-square&logo=anthropic&logoColor=white"></a>
  <a data-site="deepseek" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="deepseek: 9 commands"><img alt="deepseek" src="https://img.shields.io/static/v1?label=deepseek&message=9+cmds&color=7c3aed&style=flat-square&logo=deepseek&logoColor=white"></a>
  <a data-site="gemini" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="gemini: 5 commands"><img alt="gemini" src="https://img.shields.io/static/v1?label=gemini&message=5+cmds&color=7c3aed&style=flat-square&logo=googlegemini&logoColor=white"></a>
  <a data-site="hf" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="hf: 5 commands"><img alt="hf" src="https://img.shields.io/static/v1?label=hf&message=5+cmds&color=7c3aed&style=flat-square&logo=huggingface&logoColor=white"></a>
  <a data-site="huggingface-papers" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="huggingface-papers: 2 commands"><img alt="huggingface-papers" src="https://img.shields.io/static/v1?label=huggingface-papers&message=2+cmds&color=7c3aed&style=flat-square&logo=huggingface&logoColor=white"></a>
  <a data-site="lm-studio" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="lm-studio: 7 commands"><img alt="lm-studio" src="https://img.shields.io/static/v1?label=lm-studio&message=7+cmds&color=7c3aed&style=flat-square&logo=lmstudio&logoColor=white"></a>
  <a data-site="openrouter" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="openrouter: 2 commands"><img alt="openrouter" src="https://img.shields.io/static/v1?label=openrouter&message=2+cmds&color=7c3aed&style=flat-square&logo=openai&logoColor=white"></a>
  <a data-site="replicate" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="replicate: 2 commands"><img alt="replicate" src="https://img.shields.io/static/v1?label=replicate&message=2+cmds&color=7c3aed&style=flat-square&logo=replicate&logoColor=white"></a>
</p>
<p><strong>知识</strong><br>
  <a data-site="arxiv" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="arxiv: 5 commands"><img alt="arxiv" src="https://img.shields.io/static/v1?label=arxiv&message=5+cmds&color=0f766e&style=flat-square&logo=arxiv&logoColor=white"></a>
  <a data-site="google" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="google: 4 commands"><img alt="google" src="https://img.shields.io/static/v1?label=google&message=4+cmds&color=0f766e&style=flat-square&logo=google&logoColor=white"></a>
  <a data-site="wikipedia" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="wikipedia: 5 commands"><img alt="wikipedia" src="https://img.shields.io/static/v1?label=wikipedia&message=5+cmds&color=0f766e&style=flat-square&logo=wikipedia&logoColor=white"></a>
</p>
<p><strong>音频</strong><br>
  <a data-site="apple-podcasts" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="apple-podcasts: 2 commands"><img alt="apple-podcasts" src="https://img.shields.io/static/v1?label=apple-podcasts&message=2+cmds&color=16a34a&style=flat-square&logo=applepodcasts&logoColor=white"></a>
  <a data-site="netease-music" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="netease-music: 15 commands"><img alt="netease-music" src="https://img.shields.io/static/v1?label=netease-music&message=15+cmds&color=16a34a&style=flat-square&logo=neteasecloudmusic&logoColor=white"></a>
  <a data-site="spotify" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="spotify: 23 commands"><img alt="spotify" src="https://img.shields.io/static/v1?label=spotify&message=23+cmds&color=16a34a&style=flat-square&logo=spotify&logoColor=white"></a>
</p>
<p><strong>内容</strong><br>
  <a data-site="pixiv" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="pixiv: 6 commands"><img alt="pixiv" src="https://img.shields.io/static/v1?label=pixiv&message=6+cmds&color=c2410c&style=flat-square&logo=pixiv&logoColor=white"></a>
</p>
<p><strong>效率</strong><br>
  <a data-site="apple-notes" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="apple-notes: 3 commands"><img alt="apple-notes" src="https://img.shields.io/static/v1?label=apple-notes&message=3+cmds&color=475569&style=flat-square&logo=apple&logoColor=white"></a>
  <a data-site="notion" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="notion: 18 commands"><img alt="notion" src="https://img.shields.io/static/v1?label=notion&message=18+cmds&color=475569&style=flat-square&logo=notion&logoColor=white"></a>
  <a data-site="obsidian" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="obsidian: 10 commands"><img alt="obsidian" src="https://img.shields.io/static/v1?label=obsidian&message=10+cmds&color=475569&style=flat-square&logo=obsidian&logoColor=white"></a>
  <a data-site="typora" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="typora: 7 commands"><img alt="typora" src="https://img.shields.io/static/v1?label=typora&message=7+cmds&color=475569&style=flat-square&logo=typora&logoColor=white"></a>
</p>
<p><strong>桌面</strong><br>
  <a data-site="blender" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="blender: 13 commands"><img alt="blender" src="https://img.shields.io/static/v1?label=blender&message=13+cmds&color=334155&style=flat-square&logo=blender&logoColor=white"></a>
  <a data-site="docker" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="docker: 7 commands"><img alt="docker" src="https://img.shields.io/static/v1?label=docker&message=7+cmds&color=334155&style=flat-square&logo=docker&logoColor=white"></a>
  <a data-site="ffmpeg" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="ffmpeg: 11 commands"><img alt="ffmpeg" src="https://img.shields.io/static/v1?label=ffmpeg&message=11+cmds&color=334155&style=flat-square&logo=ffmpeg&logoColor=white"></a>
  <a data-site="figma" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="figma: 7 commands"><img alt="figma" src="https://img.shields.io/static/v1?label=figma&message=7+cmds&color=334155&style=flat-square&logo=figma&logoColor=white"></a>
  <a data-site="freecad" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="freecad: 15 commands"><img alt="freecad" src="https://img.shields.io/static/v1?label=freecad&message=15+cmds&color=334155&style=flat-square&logo=freecad&logoColor=white"></a>
  <a data-site="gimp" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="gimp: 12 commands"><img alt="gimp" src="https://img.shields.io/static/v1?label=gimp&message=12+cmds&color=334155&style=flat-square&logo=gimp&logoColor=white"></a>
  <a data-site="imagemagick" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="imagemagick: 6 commands"><img alt="imagemagick" src="https://img.shields.io/static/v1?label=imagemagick&message=6+cmds&color=334155&style=flat-square&logo=imagemagick&logoColor=white"></a>
  <a data-site="macos" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="macos: 60 commands"><img alt="macos" src="https://img.shields.io/static/v1?label=macos&message=60+cmds&color=334155&style=flat-square&logo=apple&logoColor=white"></a>
  <a data-site="mermaid" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="mermaid: 1 command"><img alt="mermaid" src="https://img.shields.io/static/v1?label=mermaid&message=1+cmds&color=334155&style=flat-square&logo=mermaid&logoColor=white"></a>
  <a data-site="pandoc" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="pandoc: 1 command"><img alt="pandoc" src="https://img.shields.io/static/v1?label=pandoc&message=1+cmds&color=334155&style=flat-square&logo=pandoc&logoColor=white"></a>
  <a data-site="powerpoint" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="powerpoint: 7 commands"><img alt="powerpoint" src="https://img.shields.io/static/v1?label=powerpoint&message=7+cmds&color=334155&style=flat-square&logo=microsoftpowerpoint&logoColor=white"></a>
  <a data-site="word" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="word: 7 commands"><img alt="word" src="https://img.shields.io/static/v1?label=word&message=7+cmds&color=334155&style=flat-square&logo=microsoftword&logoColor=white"></a>
</p>
<p><strong>游戏</strong><br>
  <a data-site="steam" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="steam: 7 commands"><img alt="steam" src="https://img.shields.io/static/v1?label=steam&message=7+cmds&color=9333ea&style=flat-square&logo=steam&logoColor=white"></a>
</p>
<p><strong>工具</strong><br>
  <a data-site="linear" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="linear: 10 commands"><img alt="linear" src="https://img.shields.io/static/v1?label=linear&message=10+cmds&color=0d9488&style=flat-square&logo=linear&logoColor=white"></a>
  <a data-site="qweather" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="qweather: 2 commands"><img alt="qweather" src="https://img.shields.io/static/v1?label=qweather&message=2+cmds&color=0d9488&style=flat-square&logo=icloud&logoColor=white"></a>
  <a data-site="todoist" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="todoist: 7 commands"><img alt="todoist" src="https://img.shields.io/static/v1?label=todoist&message=7+cmds&color=0d9488&style=flat-square&logo=todoist&logoColor=white"></a>
</p>
<p><strong>其他</strong><br>
  <a data-site="aws" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="aws: 1 command"><img alt="aws" src="https://img.shields.io/static/v1?label=aws&message=1+cmds&color=64748b&style=flat-square&logo=amazonaws&logoColor=white"></a>
  <a data-site="chrome" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="chrome: 2 commands"><img alt="chrome" src="https://img.shields.io/static/v1?label=chrome&message=2+cmds&color=64748b&style=flat-square&logo=googlechrome&logoColor=white"></a>
  <a data-site="cloudcompare" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="cloudcompare: 4 commands"><img alt="cloudcompare" src="https://img.shields.io/static/v1?label=cloudcompare&message=4+cmds&color=64748b&style=flat-square&logo=cloudinary&logoColor=white"></a>
  <a data-site="gh" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="gh: 6 commands"><img alt="gh" src="https://img.shields.io/static/v1?label=gh&message=6+cmds&color=64748b&style=flat-square&logo=github&logoColor=white"></a>
  <a data-site="google-scholar" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="google-scholar: 3 commands"><img alt="google-scholar" src="https://img.shields.io/static/v1?label=google-scholar&message=3+cmds&color=64748b&style=flat-square&logo=google&logoColor=white"></a>
  <a data-site="jq" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="jq: 2 commands"><img alt="jq" src="https://img.shields.io/static/v1?label=jq&message=2+cmds&color=64748b&style=flat-square&logo=json&logoColor=white"></a>
  <a data-site="netlify" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="netlify: 1 command"><img alt="netlify" src="https://img.shields.io/static/v1?label=netlify&message=1+cmds&color=64748b&style=flat-square&logo=netlify&logoColor=white"></a>
  <a data-site="pexels" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="pexels: 2 commands"><img alt="pexels" src="https://img.shields.io/static/v1?label=pexels&message=2+cmds&color=64748b&style=flat-square&logo=pexels&logoColor=white"></a>
  <a data-site="qwen" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="qwen: 8 commands"><img alt="qwen" src="https://img.shields.io/static/v1?label=qwen&message=8+cmds&color=64748b&style=flat-square&logo=alibabacloud&logoColor=white"></a>
  <a data-site="slay-the-spire-ii" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="slay-the-spire-ii: 6 commands"><img alt="slay-the-spire-ii" src="https://img.shields.io/static/v1?label=slay-the-spire-ii&message=6+cmds&color=64748b&style=flat-square&logo=steam&logoColor=white"></a>
  <a data-site="supabase" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="supabase: 1 command"><img alt="supabase" src="https://img.shields.io/static/v1?label=supabase&message=1+cmds&color=64748b&style=flat-square&logo=supabase&logoColor=white"></a>
  <a data-site="unsplash" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="unsplash: 2 commands"><img alt="unsplash" src="https://img.shields.io/static/v1?label=unsplash&message=2+cmds&color=64748b&style=flat-square&logo=unsplash&logoColor=white"></a>
  <a data-site="vercel" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="vercel: 1 command"><img alt="vercel" src="https://img.shields.io/static/v1?label=vercel&message=1+cmds&color=64748b&style=flat-square&logo=vercel&logoColor=white"></a>
  <a data-site="wechat-channels" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="wechat-channels: 2 commands"><img alt="wechat-channels" src="https://img.shields.io/static/v1?label=wechat-channels&message=2+cmds&color=64748b&style=flat-square&logo=wechat&logoColor=white"></a>
  <a data-site="yt-dlp" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="yt-dlp: 4 commands"><img alt="yt-dlp" src="https://img.shields.io/static/v1?label=yt-dlp&message=4+cmds&color=64748b&style=flat-square&logo=youtube&logoColor=white"></a>
  <a data-site="zoom" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="zoom: 2 commands"><img alt="zoom" src="https://img.shields.io/static/v1?label=zoom&message=2+cmds&color=64748b&style=flat-square&logo=zoom&logoColor=white"></a>
  <a data-site="zotero" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="zotero: 8 commands"><img alt="zotero" src="https://img.shields.io/static/v1?label=zotero&message=8+cmds&color=64748b&style=flat-square&logo=zotero&logoColor=white"></a>
</p>
</div>
<!-- END README_SITE_GRID -->

看实时目录：

```bash
unicli list
unicli list --site macos
unicli ext list
unicli ext list --tag agent
```

同一份生成目录也发布在文档站：
<https://olo-dot-io.github.io/Uni-CLI/reference/sites>

## 输出契约

普通命令都返回 v2 envelope。`mcp serve` 和 `acp` 是协议服务器，保留各自原始 stdio 协议。

```yaml
ok: true
schema_version: "2"
command: "twitter.search"
meta:
  duration_ms: 412
  count: 20
  surface: web
data:
  - { id: "...", text: "...", author: "..." }
error: null
```

错误也要可执行：

```yaml
ok: false
schema_version: "2"
command: "twitter.search"
meta:
  duration_ms: 91
data: null
error:
  code: auth_required
  message: "401 Unauthorized"
  adapter_path: "src/adapters/twitter/search.yaml"
  step: 1
  suggestion: "Run: unicli auth setup twitter"
  retryable: false
  alternatives: ["twitter.timeline", "twitter.profile"]
```

退出码：`0` 成功，`66` 空结果，`69` 服务不可用，`75` 临时失败，`77` 需要认证，`78` 配置错误。

## 自修复

adapter 默认是很小的 YAML。命令失败时，Agent 不需要猜，可以直接按错误定位到文件和步骤。

```text
1. 执行命令。
2. 读取错误 envelope。
3. 打开 error.adapter_path。
4. 修改失败 step。
5. 保存到 ~/.unicli/adapters/<site>/<command>.yaml。
6. 用 unicli repair <site> <command> 验证。
```

本地修复会在 npm 更新后继续保留。

## 写一个 adapter

```yaml
site: example
name: search
description: "Search example.com"
transport: http
strategy: public
capabilities: [fetch, select, map, limit]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false
pipeline:
  - fetch:
      url: "https://api.example.com/search?q=${{ args.query }}"
  - select: data.results
  - map:
      title: "${{ item.title }}"
      url: "${{ item.url }}"
  - limit: "${{ args.limit }}"
args:
  - { name: query, type: string, required: true, positional: true }
  - { name: limit, type: int, default: 20 }
columns: [title, url]
```

文档入口：

- [独立文档站](https://olo-dot-io.github.io/Uni-CLI/)
- [快速开始](docs/guide/getting-started.md)
- [Agent 集成](docs/guide/integrations.md)
- [Adapter 格式](docs/ADAPTER-FORMAT.md)
- [Pipeline 参考](docs/reference/pipeline.md)
- [Exit codes](docs/reference/exit-codes.md)

## 边界和诚实说明

- 需要登录的网站使用本地 cookie 文件：`~/.unicli/cookies/<site>.json`。
- Browser adapter 需要可连接的 Chrome/CDP。
- Permission profile 是用户选择的运行时策略。默认是 `open`；更严格的
  `confirm` 和 `locked` profile 会要求 `--yes` 或 `UNICLI_APPROVE=1`。
  `--yes` 加 `--remember-approval` 会把同一条命令的 capability 和资源 scope
  记到 `~/.unicli/approvals.jsonl`。资源 scope 来自稳定 metadata，比如域名、
  账号面、应用、进程族和路径参数槽。用 `unicli approvals list`、`revoke`、
  `clear` 查看或移除已记住的 scope。文件只存 scope metadata，原始运行参数留在审批记忆之外。
- 本地 deny 规则放在 `~/.unicli/permission-rules.json`，也可以用
  `UNICLI_PERMISSION_RULES_PATH` 指定。规则按站点、命令、effect、capability
  维度和资源 metadata 匹配，优先级高于 `--yes` 和已记住的审批。运行时还会检查
  fetch 域名、浏览器跳转目标、下载和输出路径、子进程可执行文件，命中后在请求、写入或
  启动进程之前停下。
- Run recording 是显式启用能力。需要可审查证据时使用 `--record` 或
  `UNICLI_RECORD_RUN=1`，追加写入 `~/.unicli/runs`。
- CUA 路由必须配置真实 backend。声明了但不可用的 provider 会失败关闭，并返回结构化错误。
- 用户 adapter 和修复放在 `~/.unicli/adapters/`；包内 adapter 是基线。
- 如果网站阻止自动化或私有 API 变了，Uni-CLI 会返回清楚的失败 envelope。

## 开发

```bash
npm install
npm run typecheck
npm run lint
npm run verify
```

## License

[Apache-2.0](./LICENSE)

<p align="center">
  <sub>v0.220.0 — Apollo · Lovell</sub>
</p>
