<!-- 由 docs/zh/glossary.md 生成。不要直接编辑此副本。 -->

# 术语表

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/glossary
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/glossary.md
- 栏目: 上手
- 上级: 上手 (/zh/)

Uni-CLI 文档、源码、YAML 适配器里用到的术语标准定义。每条都做成独立段落，方便 AI 助手在回答项目相关问题时直接引用。

## Agent-Computer Interface (ACI)

Agent 能向 computer 发出的命令，以及 computer 返回的反馈。Uni-CLI 把这条 interface 实现成横跨异构真实软件的 runtime：发现并选择 operation，治理已覆盖 effect，通过 operation 已声明的 substrate 行动，观察结构化结果，并修复支持的失败。这个术语描述产品边界，不代表某一种 wire protocol、visual interface、Agent framework 或自动 substrate 仲裁。

## Action substrate (行动 substrate)

Uni-CLI 可以用来让真实软件行动的具体技术边界：HTTP、browser CDP、desktop accessibility、subprocess、文件操作、协议服务、visual fallback 或 App-specific harness。substrate 位于 Agent-Computer Interface runtime 边界之下。

## Adapter (适配器)

把一个站点或工具映射到一组操作的 YAML 或 TypeScript 文件。声明 site、命令名、type、strategy、args、pipeline、columns。推荐格式是 YAML；TypeScript 留给无法由共享 action 组合表达、确实需要命令式控制流的场景。

## Adapter type (适配器类型)

适配器面向的集成表面。五种：`web-api` 走 HTTP API；`browser` 通过 CDP 全控 Chrome；`desktop` 跑本地子进程；`bridge` 透传现成 CLI；`service` 接 WebSocket 或 HTTP 服务（Ollama、OBS、ComfyUI）。

## AgentEnvelope (v2)

Uni-CLI formatter 产出的结构化回执。包含 `ok`、`schema_version`、`command`、`meta`、`data`、`error`，以及可选的 `content` 与 `next_actions`。成功时 `data` 装结果且 `error` 为 null；失败时 `data` 为 null，`error` 一定有 `code` 与 `message`，source path、step、suggestion、retryability、alternatives 和 outcome ambiguity 仅在适用时出现。

## AGENTS.md

Agent 运行时启动时读取的发现文件，用来了解可用工具。Uni-CLI 在 `AGENTS.md` 注册自己，Agent 不用做单独配置就能识别。

## Bilingual BM25 search (双语 BM25 搜索)

Uni-CLI 把自然语言意图映射到站点、操作、参数的发现算法。中英文双语索引适配器元数据，TF-IDF 加权。`unicli search "<intent>"` 返回排序好的候选。

## Bridge adapter (桥接适配器)

把现成 CLI (`gh`、`docker`、`yt-dlp`、`lark-cli`) 包装进 Uni-CLI 操作目录的适配器。纯透传——Uni-CLI 不重新实现包装的 CLI，只做注册、自动安装、统一发现。

## Browser adapter (浏览器适配器)

通过 CDP 驱动 Chrome 的适配器，用于需要交互会话、JS 执行、登录态的站点。使用 `navigate`、`evaluate`、`click`、`type`、`wait`、`intercept`、`tap`、`snapshot` 等注册 action；截图由 browser/compute operation 暴露，不存在通用 `screenshot` pipeline action。

## Catalog (目录)

所有站点、操作、参数、策略、输出 schema 的本地索引。安装时生成，适配器变更时更新。通过 `unicli search` 查询，不需要枚举——Agent 只在需要发现时才付目录成本。

## CDP (Chrome DevTools Protocol)

Uni-CLI 用来控制真实 Chrome 实例的 wire protocol。在 `src/browser/cdp-client.ts` 里以原生 WebSocket 客户端实现，没有第三方浏览器库依赖。支持完整的 Page、Network、DOM、Runtime domain。

## Compute (Visual)

本地 computer-control 和视觉兜底的适配器家族。当结构化 substrate (web-api、desktop AX、browser CDP、App API、subprocess) 都够不到目标时，Compute 可以通过截图、点击、输入和执行后证据，走统一动作集驱动屏幕。

## Cookie file (Cookie 文件)

用户可以显式把每站认证态以 plaintext JSON 存到 `~/.unicli/cookies/<site>.json`；`cookie`/`header` adapter 也可以只把 live browser/CDP Cookie 读入本次进程内存。Cookie 值只发送给该命令选择的目标请求/浏览器边界。

## Browser Runtime Broker (浏览器运行时代理)

CLI、MCP、native host 与插件共用的机器级、仅所有者可访问的浏览器控制平面。它认证本地 IPC，管理 Agent session 与 target lease，按 target 串行化变更，并只在请求时启动 managed、existing-Chrome 或 remote provider；broker 自身不会打开浏览器窗口。

## Desktop adapter (桌面适配器)

通过 `exec` 和 `write_temp` pipeline step 调用本地二进制 (`ffmpeg`、`imagemagick`、`blender`) 的适配器。用于媒体处理、文件转换、任何已经在 PATH 里的 CLI 工具。

## Discovery (发现)

Agent 把自然语言意图映射到具体操作的阶段。由 `unicli search "<intent>"` 在本地操作目录上完成。发现成本有上界——实测 token 预算参见 [docs/BENCHMARK.md](/zh/BENCHMARK)。

## Error envelope (错误回执)

`ok` 为 false 时 v2 AgentEnvelope 上的 `error` 字段。一定带 `code` 与 `message`；根据失败类型，还可以带 `adapter_path`、`step`、`suggestion`、`retryable`、`alternatives`、`outcome_ambiguous`、`target_unusable` 或 remedy。可选字段不是通用 completion evidence。

## Exit code (退出码)

CLI command 使用的 process status。0 代表成功；结构化 command failure 会映射到 sysexits-style 类别，例如 66 empty result、69 service unavailable、75 temporary failure、77 auth、78 config；Commander usage failure 使用自身非零状态。Exit status 属于 process boundary，不是 AgentEnvelope 必填字段。

## Header strategy

把显式 cookie storage 或 live browser/CDP session 读入内存，自动抽取 CSRF token，再把两者注入目标请求 header 的认证策略。用于状态变更请求需要 CSRF 的站点 (Reddit `vote`、Twitter `like`)。

## Intercept strategy

让真实浏览器会话访问目标页面，并捕获页面自己加载的 XHR/fetch 响应的认证策略。用于站点 API 没文档、或需要复杂的会话状态难以手动复现的场景。

## llms.txt

站点根目录的 Agent 可读索引文件 (`/llms.txt` 和 `/llms-full.txt`)。列出关键文档页和对应的 Markdown 伴侣 URL，方便 AI 助手不渲染 HTML 就能拉取并引用文档。

## MCP (Model Context Protocol)

一个把 AI 应用与工具、数据通过有状态服务连接起来的[开放标准](https://modelcontextprotocol.io/)。Uni-CLI 自带可选 MCP 网关 (`unicli mcp serve`)，用 default、deferred、expanded profile 暴露 adapter operation。固定 core command 在 protocol parity 完成前仍以 native CLI 为规范入口。

## Operation contract (操作合同)

Uni-CLI 稳定的产品原语。operation contract 描述 identity、args、输出形状、认证姿态、行动 substrate、effect、risk、capability、source path 和 repair path。Adapter CLI 与 MCP projection 当前共享 adapter contract；固定 core 和其他 integration parity 是设计 invariant 与路线图目标，不代表今天每个 surface 都能 dispatch 每条 cataloged command。

## Pipeline

适配器为产出结果按顺序执行的 action 列表。可执行 built-in surface 共
<span><!-- STATS:pipeline_step_count -->105<!-- /STATS --></span> 个名字：
<span><!-- STATS:pipeline_registered_step_count -->50<!-- /STATS --></span>
个注册 pipeline action，加
<span><!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --></span>
个底层 transport-native action。action 共享 context；plugin 不计入该预算。

## Pipeline step (Pipeline 步骤)

适配器 pipeline 里的一个工作单元。例：`fetch`、`select`、`map`、`filter`、`navigate`、`click`、`intercept`、`if`、`each`、`assert`。纯变换 action 可以是确定性的；外部 action 保持结构化 result/error handling，并可发出与 operation 相符的 network、browser、desktop 或 subprocess evidence。

## Public strategy

最便宜的认证策略。无凭据直接 fetch。用于公开 API 的站点 (RSS、搜索端点、公共统计)。只有 command 使用有界 HTTP auth probe 时，它才一定先被尝试。

## Repair (修复)

失败操作进入有边界 source change 或换路的阶段。错误回执指出失败 source path 和 step 或边界后，Agent 改 YAML/代码或选择替代路径，然后跑 `unicli repair <site> <command>` 或 delivery verification 证明修复。用户本地补丁存在 `~/.unicli/adapters/`。

## Self-repair (自修复)

让 Agent 在软件漂移时修复自己的集成的能力。由几部分组成：结构化错误回执、Agent 可读 source path、修复验证命令、替代路径、持久化覆盖目录。这是让 operation-as-YAML 经济上跑得通的核心设计选择之一。

## Service adapter (服务适配器)

通过 WebSocket 或 HTTP 与长生命服务 (Ollama、OBS Studio、ComfyUI) 对话的适配器，可选 API key 认证。和 `web-api` 的区别是连接跨 pipeline step 持久。

## Site (站点)

适配器的集成目标。通常是网站 (`reddit`、`twitter`、`bilibili`)，也可以是桌面应用 (`obsidian`)、外部 CLI (`gh`)、本地服务 (`ollama`)。

## Snapshot

浏览器适配器中 `snapshot` pipeline step 生成的 DOM 可访问性树。产出可交互的 ref 编号，后续 `click`、`type`、`extract` 步骤引用。用于需要稳定元素定位的适配器。

## Strategy (策略)

Adapter 声明的认证或交互路径：`public`、`cookie`、`header`、`intercept`、`ui`。这五个值不是一条自动五路 cascade。只有 `public`、`cookie`、`header` 进入有界 HTTP probe；`intercept` 与 `ui` 是显式 browser-backed strategy。

## Strategy cascade (策略级联)

存在 probe URL 时使用的有界 HTTP 探测。依次尝试 `public`、`cookie`、`header`，并在进程内缓存第一个有效结果。它不会静默升级到 `intercept` 或 `ui`；browser-backed strategy 必须由 operation 明确声明。

## Tap

把 Vue store (Pinia、Vuex) 桥接到网络抓取的 pipeline step。驱动页面自己的 state action，然后捕获产生的 XHR/fetch 响应。用于客户端状态深的站点 (Twitter、Bilibili、Notion)。

## UI strategy

最贵的认证策略。交互式驱动真实浏览器会话——点击、输入、snapshot、wait。用于站点需要无法通过 header 注入或 XHR 重放复现的多步用户交互。

## v2 envelope version (v2 envelope 版本)

当前 AgentEnvelope schema。它使用 `schema_version: "2"`、`ok` 判别式 success/error union、`command`、`meta`、`data`、`error` 与可选 content/next-action block。Shell exit status 在 process boundary 与 envelope 并行映射，不是 envelope 必填字段。

## Web-api adapter

直接打 HTTP API、不涉及浏览器的适配器。最常见的适配器类型。拉取用 `fetch`、`fetch_text`、`parse_rss`、`html_to_md`；变形用 `select`、`map`、`filter`。

## YAML adapter (YAML 适配器)

推荐的适配器格式。20-30 行声明 site、name、type、strategy、args、pipeline、columns。Agent 可读、Agent 可改、无图灵完备逻辑，因此 Agent 可以确定性地 patch。存在 `~/.unicli/adapters/<site>/<name>.yaml`。
