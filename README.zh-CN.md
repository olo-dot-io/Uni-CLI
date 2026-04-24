<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
    <img src="assets/logo-light.svg" alt="Uni-CLI" width="360">
  </picture>
</p>

<h1 align="center">Uni-CLI</h1>

<p align="center">
  <strong>给 Agent 用的一层统一 CLI：网站、桌面 App、本地工具、外部 CLI，都变成可搜索、可执行、可修复的命令。</strong>
</p>

<p align="center">
  先按意图搜索，再执行真实命令，最后拿结构化结果。网站变了也不会假装成功，错误会告诉你哪个 adapter、哪一步、怎么修。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@zenalexa/unicli"><img alt="npm" src="https://img.shields.io/npm/v/@zenalexa/unicli?style=flat-square"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
  <img alt="node >=20" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-2025--11--25-6f42c1?style=flat-square">
</p>

<p align="center">
  <sub><!-- STATS:site_count -->220<!-- /STATS --> 个站点 · <!-- STATS:command_count -->1283<!-- /STATS --> 条命令 · <!-- STATS:pipeline_step_count -->59<!-- /STATS --> 个 pipeline step · <!-- STATS:test_count -->7160<!-- /STATS --> 个测试</sub>
</p>

```bash
npm install -g @zenalexa/unicli
unicli search "微博热搜"
unicli hackernews top -f json
```

<!-- IF YOU ARE AN AI AGENT: Start here.
Install: npm install -g @zenalexa/unicli
Discover: unicli search "your intent"
Run: unicli <site> <command> [args] [-f json|md|yaml|csv|compact]
Repair: read the error envelope, edit the adapter_path, run unicli repair <site> <command>
Prefer native CLI / JSON stream / MCP for agent runtimes. Use ACP as an editor compatibility gateway.
-->

## 它解决什么

Uni-CLI 把软件表面封装成 Agent 能发现、能执行、能修的命令。

| 表面         | 能力                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| 网站和 API   | public、cookie、header、browser-intercept 等 adapter                            |
| 浏览器自动化 | CDP 的 navigate、click、type、intercept、snapshot、extract、wait 等步骤         |
| 桌面和 macOS | 系统命令、App adapter、截图、剪贴板、日历、亮度、本地工具                       |
| 外部 CLI     | 58 个已登记的 passthrough bridge，支持安装和状态发现                            |
| Agent 后端   | native CLI、JSON stream、MCP、ACP、HTTP API、OpenAI-compatible、bridge 路由矩阵 |
| 输出         | v2 `AgentEnvelope`，支持 Markdown、JSON、YAML、CSV、compact                     |
| 修复         | 错误里带 `adapter_path`、失败 `step`、是否可重试、修复建议和替代命令            |

## 给 Agent 的入口

先搜索，再执行最小可用命令。

```bash
unicli search "推特热门" --limit 5
unicli twitter search "coding agents" -f json
unicli repair twitter search
```

非 TTY 和 Agent 环境默认输出结构化 Markdown。需要机器格式时显式指定：

```bash
UNICLI_OUTPUT=json unicli reddit hot --limit 10
unicli hackernews top --limit 5 -f yaml
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

数量不是重点，重点是每条命令都能搜索、可声明、可验证、可修。

| 领域          | 例子                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| 中文平台      | xiaohongshu、zhihu、bilibili、douyin、douban、v2ex、jike、linux-do                                          |
| 国际平台      | twitter、reddit、instagram、tiktok、discord、slack、hackernews、lesswrong                                   |
| AI 和开发工具 | Claude、ChatGPT、Gemini、Codex、Cursor、VS Code、Docker Desktop、Postman                                    |
| 财经和新闻    | xueqiu、eastmoney、yahoo-finance、bloomberg、reuters、bbc、36kr                                             |
| 桌面 App      | Blender、FreeCAD、GIMP、Audacity、Figma、Docker、ImageMagick、ffmpeg                                        |
| Agent CLI     | Claude Code、Codex、OpenCode、Gemini CLI、Qwen Code、Aider、Goose、Cursor Agent、Kiro、OpenHands、SWE-agent |

看实时目录：

```bash
unicli list
unicli list --site macos
unicli ext list
unicli ext list --tag agent
```

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

- [快速开始](docs/QUICKSTART.md)
- [Adapter 格式](docs/ADAPTER-FORMAT.md)
- [Pipeline 参考](docs/reference/pipeline.md)
- [架构](docs/ARCHITECTURE.md)
- [ACP / avante.nvim](docs/AVANTE.md)
- [Benchmark](docs/BENCHMARK.md)

## 边界和诚实说明

- 需要登录的网站使用本地 cookie 文件：`~/.unicli/cookies/<site>.json`。
- Browser adapter 需要可连接的 Chrome/CDP。
- CUA 路由必须配置真实 backend。声明了但不可用的 provider 会失败关闭，并返回结构化错误。
- 用户 adapter 和修复放在 `~/.unicli/adapters/`；包内 adapter 是基线。
- 如果网站阻止自动化或私有 API 变了，正确行为是清楚失败，不是伪装成功。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm lint
npm run verify
```

## License

[Apache-2.0](./LICENSE)

<p align="center">
  <sub>0.215.1</sub>
</p>
