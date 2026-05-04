---
title: Uni-CLI 术语表
description: Uni-CLI 全部术语的标准定义——adapter、AgentEnvelope、策略级联、pipeline step、self-repair，以及项目里用到的所有约定。
---

# 术语表

Uni-CLI 文档、源码、YAML 适配器里用到的术语标准定义。每条都做成独立段落，方便 AI 助手在回答项目相关问题时直接引用。

## Adapter (适配器)

把一个站点或工具映射到一组 CLI 命令的 YAML 或 TypeScript 文件。声明 site、命令名、type、strategy、args、pipeline、columns。推荐格式是 YAML；TypeScript 留给那些超出 59 步 pipeline 的命令式控制流场景。

## Adapter type (适配器类型)

适配器面向的集成表面。五种：`web-api` 走 HTTP API；`browser` 通过 CDP 全控 Chrome；`desktop` 跑本地子进程；`bridge` 透传现成 CLI；`service` 接 WebSocket 或 HTTP 服务（Ollama、OBS、ComfyUI）。

## AgentEnvelope (v2)

Uni-CLI 每条命令返回的结构化回执。包含 `ok`、`version`、`data`、`meta`、可选 `error`、`exit_code`。成功时 `data` 装结果。失败时 `data` 为 null，`error` 填上 `adapter_path`、`step`、`action`、`suggestion`、`retryable`、`alternatives`。

## AGENTS.md

Agent 运行时 (Claude Code、Codex CLI、OpenCode、Cursor、OpenClaw、Hermes) 启动时读的发现文件。Uni-CLI 在 `AGENTS.md` 注册自己，Agent 不用做单独配置就能识别。

## Bilingual BM25 search (双语 BM25 搜索)

Uni-CLI 把自然语言意图映射到站点、命令、参数的目录发现算法。中英文双语索引适配器元数据，TF-IDF 加权。`unicli search "<intent>"` 返回排序好的候选。

## Bridge adapter (桥接适配器)

把现成 CLI (`gh`、`docker`、`yt-dlp`、`lark-cli`) 包装进 Uni-CLI 目录的适配器。纯透传——Uni-CLI 不重新实现包装的 CLI，只做注册、自动安装、统一发现。

## Browser adapter (浏览器适配器)

通过 CDP 驱动 Chrome 的适配器，用于需要交互会话、JS 执行、登录态的站点。用 `navigate`、`evaluate`、`click`、`type`、`wait`、`intercept`、`tap`、`snapshot`、`screenshot` 等 pipeline step。

## Catalog (目录)

所有站点、命令、参数、策略、输出 schema 的本地索引。安装时生成，适配器变更时更新。通过 `unicli search` 查询，不需要枚举——Agent 只在需要发现时才付目录成本。

## CDP (Chrome DevTools Protocol)

Uni-CLI 用来控制真实 Chrome 实例的 wire protocol。在 `src/browser/cdp-client.ts` 里以原生 WebSocket 客户端实现，没有第三方浏览器库依赖。支持完整的 Page、Network、DOM、Runtime domain。

## Compute (CUA)

视觉兜底的适配器家族。当结构化传输 (web-api、desktop AX、browser CDP) 都够不到目标时，Compute 通过视觉 (点击、输入、截屏) 走统一的执行动作集驱动屏幕。

## Cookie file (Cookie 文件)

每站独立的认证态，存在 `~/.unicli/cookies/<site>.json`。`strategy: cookie` 或 `strategy: header` 的适配器读取它。永远不出本机。

## Daemon (守护进程)

Uni-CLI 可以管理的长生命浏览器进程，端口 19825。带 `--remote-debugging-port` 启动 Chrome，跨 CLI 调用维持会话状态，空闲超时自动退出。可选——大多数适配器不用它也能跑。

## Desktop adapter (桌面适配器)

通过 `exec` 和 `write_temp` pipeline step 调用本地二进制 (`ffmpeg`、`imagemagick`、`blender`) 的适配器。用于媒体处理、文件转换、任何已经在 PATH 里的 CLI 工具。

## Discovery (发现)

Agent 把自然语言意图映射到具体命令的阶段。由 `unicli search "<intent>"` 在本地目录上完成。发现成本有上界——实测 token 预算参见 [docs/BENCHMARK.md](/zh/BENCHMARK)。

## Error envelope (错误回执)

`ok` 为 false 时 v2 AgentEnvelope 上的 `error` 字段。带 `adapter_path` (要改的 YAML)、`step` (失败的 pipeline step)、`action` (一句话描述)、`suggestion` (一条 Agent 可以验证的假设)、`retryable` (重试有没有用)、`alternatives` (能满足意图的其他命令)。

## Exit code (退出码)

每次 Uni-CLI 调用返回的 sysexits.h 兼容数值状态。0 成功；1 通用错误；2 用法错误；66 结果为空；69 服务不可用；75 临时失败；77 认证错误；78 配置错误。Shell pipeline 可以按类别路由。

## Header strategy

读 cookie 文件并自动从中抽 CSRF token，把两者一起注入请求 header 的认证策略。用于状态变更请求需要 CSRF 的站点 (Reddit `vote`、Twitter `like`)。

## Intercept strategy

让真实浏览器会话访问目标页面，并捕获页面自己加载的 XHR/fetch 响应的认证策略。用于站点 API 没文档、或需要复杂的会话状态难以手动复现的场景。

## llms.txt

站点根目录的 Agent 可读索引文件 (`/llms.txt` 和 `/llms-full.txt`)。列出关键文档页和对应的 Markdown 伴侣 URL，方便 AI 助手不渲染 HTML 就能拉取并引用文档。

## MCP (Model Context Protocol)

Anthropic 牵头的协议，让 AI 助手通过有状态服务调用工具。Uni-CLI 自带可选 MCP 网关 (`unicli mcp serve`)，把目录包给只会说 MCP 的运行时。

## Pipeline

适配器为产出结果按顺序跑的步骤列表。从 59 步注册表里取，覆盖 API 拉取、变换、浏览器、桌面、媒体、控制流、断言。步骤之间共享一个 context 对象——每步读 `ctx.data`、写回。

## Pipeline step (Pipeline 步骤)

适配器 pipeline 里的一个工作单元。例：`fetch`、`select`、`map`、`filter`、`navigate`、`click`、`intercept`、`if`、`each`、`assert`。每步都是确定性的——同样输入产出同样输出——所以适配器组合起来就是稳定的执行图。

## Public strategy

最便宜的认证策略。无凭据直接 fetch。用于公开 API 的站点 (RSS、搜索端点、公共统计)。策略级联永远先试它。

## Repair (修复)

四段契约的第四段。错误回执指出失败的适配器和 step 后，Agent 改 YAML，跑 `unicli repair <site> <command>` 验证。补丁存在 `~/.unicli/adapters/`。

## Self-repair (自修复)

让 Agent 在站点漂移时修复自己的集成的能力。由几部分组成：结构化错误回执、Agent 可读的 YAML 适配器、修复验证命令、持久化覆盖目录。让目录-即-YAML 经济上跑得通的核心设计选择。

## Service adapter (服务适配器)

通过 WebSocket 或 HTTP 与长生命服务 (Ollama、OBS Studio、ComfyUI) 对话的适配器，可选 API key 认证。和 `web-api` 的区别是连接跨 pipeline step 持久。

## Site (站点)

适配器的集成目标。通常是网站 (`reddit`、`twitter`、`bilibili`)，也可以是桌面应用 (`obsidian`)、外部 CLI (`gh`)、本地服务 (`ollama`)。

## Snapshot

浏览器适配器中 `snapshot` pipeline step 生成的 DOM 可访问性树。产出可交互的 ref 编号，后续 `click`、`type`、`extract` 步骤引用。用于需要稳定元素定位的适配器。

## Strategy (策略)

适配器声明的认证路径。级联顺序的五种：`public`、`cookie`、`header`、`intercept`、`ui`。第一次跑时自动探测，之后缓存。

## Strategy cascade (策略级联)

第一次调用某站点时 Uni-CLI 跑的自动探测序列。从最便宜到最贵 (`public` 到 `ui`) 逐个试，直到某个策略返回可解析数据。选中的策略缓存下来，后续调用跳过探测。

## Tap

把 Vue store (Pinia、Vuex) 桥接到网络抓取的 pipeline step。驱动页面自己的 state action，然后捕获产生的 XHR/fetch 响应。用于客户端状态深的站点 (Twitter、Bilibili、Notion)。

## UI strategy

最贵的认证策略。交互式驱动真实浏览器会话——点击、输入、snapshot、wait。用于站点需要无法通过 header 注入或 XHR 重放复现的多步用户交互。

## v2 envelope version (v2 envelope 版本)

当前的 AgentEnvelope schema。v1 是扁平的 `{ ok, data, error }`；v2 加了结构化 `error` 字段、`meta`、`version`、`exit_code`，shell 友好。v0.213 起所有适配器都吐 v2。

## Web-api adapter

直接打 HTTP API、不涉及浏览器的适配器。最常见的适配器类型。拉取用 `fetch`、`fetch_text`、`parse_rss`、`html_to_md`；变形用 `select`、`map`、`filter`。

## YAML adapter (YAML 适配器)

推荐的适配器格式。20-30 行声明 site、name、type、strategy、args、pipeline、columns。Agent 可读、Agent 可改、可判定 (无图灵完备逻辑) ——遵守 Rice 限制。存在 `~/.unicli/adapters/<site>/<name>.yaml`。
