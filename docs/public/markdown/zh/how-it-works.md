<!-- 由 docs/zh/how-it-works.md 生成。不要直接编辑此副本。 -->

# 工作原理

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/how-it-works
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/how-it-works.md
- 栏目: 上手
- 上级: 上手 (/zh/)

Uni-CLI 是面向真实软件的开源 Agent-Computer Interface 运行时。它在 Agent 与网站、登录态浏览器、桌面应用、本地工具、文件、操作系统能力、MCP 服务、外部 CLI、accessibility 和 visual control 之间提供一个可搜索边界。这一页讲清当前闭环：意图怎样排序已编目 operation，Agent 怎样选择已声明 substrate 的 operation，策略怎样在执行前生效，AgentEnvelope 怎样报告调用，以及真实软件变化时 repair 怎样让路径保持可诊断。

## Agent-Computer Interface 契约

公开的六个动词是当前可执行 stage 的精简模型，不代表每一种 transport 都有完全
相同的 dispatch 或 evidence 行为。

1. **发现（`intent`）**：`unicli search "<意图>"` 和只产出计划的 `unicli do
"<意图>"` 检索一小组排序结果；两者都不会执行外部动作。
2. **选择（`select`）**：Agent 选择一条已声明 strategy 与 substrate 的
   operation。在全部替代路径间自动仲裁属于路线图能力，并非当前行为。
3. **治理（`govern`）**：permission profile、deny rule、capability scope 与本地
   policy 在调用前暴露或拦截已覆盖的 effect。
4. **行动（`act`）**：adapter command 使用共享 adapter kernel；固定 core
   command 保持各自的 native CLI handler。
5. **观察（`observe`、`diagnose`、`deliver`）**：AgentEnvelope 始终区分成功与
   错误并携带 timing metadata；artifact、recording、post-state check 与 trajectory
   evidence 都取决于具体 operation。
6. **修复（`repair-or-reroute`）**：operation 提供相应上下文时，结构化错误和
   delivery field 可以约束下一次 diagnosis、repair 或 reroute。

`expose` 是第九个可执行 stage。Adapter operation 会投影到 native CLI 与 MCP
default/deferred/expanded profile；固定 core command 当前以 native CLI 为规范入口，
完整跨协议 parity 是路线图工作。

## Substrate 不是身份

浏览器自动化、computer-use sandbox、本地执行、MCP 服务、页面原生工具和单 App
harness 都有价值，但它们不是 Uni-CLI 的类目。它们是 Agent-Computer Interface
可以执行或暴露的具体技术边界。

| Substrate         | 贡献什么                                           | Uni-CLI 在它上面保留什么                  |
| ----------------- | -------------------------------------------------- | ----------------------------------------- |
| Web/API           | typed fetch、cookie/header auth、download、extract | operation contract、policy、结构化结果    |
| Browser           | CDP 控制、DOM/accessibility ref、截图、网络捕获    | 已声明 strategy、recording、诊断          |
| Desktop/OS        | installed app、无障碍树、截图、本地状态            | governed action 与平台诊断                |
| 本地工具/文件     | subprocess、PDF、媒体工具、开发者 CLI              | typed args、output envelope、retryability |
| 协议              | MCP、ACP、Streamable HTTP、JSON stream             | 当前投影 adapter；更广 parity 在路线图中  |
| Visual coordinate | 显式的桌面像素与坐标交互                           | 真实性闸门：只声明能看见、能行动的路径    |

## 它在协议栈中的位置

2026 年的 Agent 协议栈正在按边界分工。[ARD](https://agenticresourcediscovery.org/spec/) 与 [MCP Registry](https://modelcontextprotocol.io/registry/about) 发布能力在哪里；[MCP](https://modelcontextprotocol.io/) 连接 Agent 与工具/数据；[WebMCP](https://developer.chrome.com/docs/ai/webmcp) 让主动接入的页面发布 live tool；[A2A](https://developers.googleblog.com/en/how-a2a-is-building-a-world-of-collaborative-agents/) 连接协作 Agent。Uni-CLI 不需要替换其中任何一层。

Uni-CLI 负责 discovery 之后的本地 operation 边界：检查可执行路径，读取 operation
已声明的 substrate，应用当前策略，执行并报告结果，在支持时保留 repair context。
ARD、registry ingestion 与更广的 semantic substrate arbitration 是架构方向，而不是
已发布的自动行为。标准成熟后，应当作为 discovery input、execution substrate 或
exposure format 进入 runtime，而不是引发架构重写。

## 领域感知发现

目录搜索不是单纯按站点名匹配。它把双语 BM25、命令元数据、alias 和领域词表合在一起，让 Agent 先搜实体，再选择合适表面。例如 `花火 星穹铁道 character` 会更容易落到角色/wiki/动画来源，`blue_archive rating:safe` 会更容易落到 booru tag 搜索。日文名、罗马音、中文名、英文名作为相关 adapter 表面的 alias 维护，而不是写成一次性的站点捷径。

同一条规则也避免泛查询被误导。只有查询里明确出现 ACG、论文、wiki、tag、游戏、动画、漫画、美少女游戏等领域词时，领域 boost 才生效；普通查询仍然按 Web、开发、财经或 App 命令自己的证据排序。

### AI 一手信息情报

`unicli ai` 把同一个 operation contract 用在 AI 研究与工程信号上。
`ai profiles` 列出大模型、训练、推理、世界模型、具身智能、硬件、Agent、
评测安全与研究岗位每天关注什么；`ai landscape` 给出维护中的实验室、厂商、
runtime、模型社区、论文平台、benchmark、机器人与社区全景；`ai search` 根据
岗位选择原生实时 adapter 和相关官方域名；`ai pulse` 执行有界岗位查询并融合
带可验证时间戳的结果。ModelScope、OpenCSG、Bluesky 帖子、OpenReview、
OpenAlex、Crossref、ACL Anthology、YouTube，以及已有的 GitHub、Hugging Face、
Web 与社区 adapter 都进入同一个来源和归属合同。

这些命令在调用时获取上游当前状态，不声称后台爬虫或零索引延迟，也不会补造
时间戳。X、Reddit、Linux.do、知乎和哔哩哔哩在 `ai sources` 中可见，但必须
显式选择，或使用 `ai pulse --include-auth`。社区平台被列入全景不等于平台上的
任意帖子是一手官方内容；只有匹配维护者官方域名或精确 GitHub 仓库时才标成
first-party。

```bash
unicli ai profiles -f json
unicli ai landscape --profile world-models -f json
unicli ai pulse --profile inference --window week -f json
unicli ai search "KV cache scheduler" --profile inference --sort latest -f json
```

## 内部作者格式：YAML adapter

YAML adapter 是默认的可复用 operation contract 作者格式。它不是平台身份；它是便宜、可检查的格式，让 Agent 能读、能改、能验证很多 substrate 路径。下面是一个公开 RSS 订阅的完整适配器：

```yaml
site: techcrunch
name: latest
type: web-api
strategy: public
pipeline:
  - fetch_text:
      url: https://techcrunch.com/feed/
  - parse_rss: {}
  - limit: 10
  - map:
      title: "${{ item.title }}"
      url: "${{ item.link }}"
      published: "${{ item.published }}"
columns: [title, published, url]
```

五个字段定义作者单元：`site` (集成名)、`name` (命令)、`type` (面向哪个 substrate: web-api / browser / desktop / bridge / service)、`strategy` (认证路径)、`pipeline` (产出结果的步骤)。零 import、零 class、零编译——Agent 直接读、直接改选择器、几秒就验证完。

## 内部 pipeline 注册表

runtime 暴露 <span><!-- STATS:pipeline_step_count -->113<!-- /STATS --></span>
个 built-in action name，但它们不是一门扁平编程语言：
<span><!-- STATS:pipeline_registered_step_count -->58<!-- /STATS --></span>
个属于注册 pipeline action，另有
<span><!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --></span>
个是 Visual/AX/UIA/AT-SPI 的底层 transport-native action。预算由机器门禁；新行为
默认应组合已有 action，或进入 plugin/transport 边界，而不是继续扩张共享词表。
`retry`、`backoff` 是有界 sibling metadata，不是 action name。

纯变换可以是确定性的；network、browser、desktop、subprocess 面对外部状态，承诺
的是稳定输入、错误和证据合同，不冒充同输入必得同输出。

| 类别   | 示例                                                                | 用途                      |
| ------ | ------------------------------------------------------------------- | ------------------------- |
| API    | `fetch`、`fetch_text`、`parse_rss`、`html_to_md`                    | HTTP 拉取与结构化抽取     |
| 变换   | `select`、`map`、`filter`、`sort`、`limit`                          | 在步骤之间变形 JSON       |
| 浏览器 | `navigate`、`evaluate`、`click`、`type`、`wait`、`intercept`、`tap` | 通过 CDP 控制 Chrome      |
| 桌面   | `exec`、`write_temp`                                                | 子进程控制                |
| 媒体   | `download`、`websocket`                                             | 文件和流式抓取            |
| 控制   | `set`、`if`、`each`、`parallel`、`rate_limit`、`assert`             | 组合原语                  |
| 原生   | `visual_*`、`ax_*`、`uia_*`、`atspi_*`                              | 显式底层 transport action |
| 输出   | `extract`、columns                                                  | 给 Agent 的最终形状       |

Pipeline 自上而下走，共享一个 context 对象。每步读 `ctx.data`、写回。模板 (`${{ item.field }}`) 从前一步输出里取值。

## 策略级联

认证是接触现代 web 时最脏的部分。Operation 可以声明五种 strategy 之一，但它们
运行时只执行 operation 声明的 strategy，失败后不会自动切换到另一种
strategy。`public`、`cookie`、`header` 是独立的结构化 HTTP 合约；
`intercept` 和 `ui` 是浏览器合约。跨 strategy 需要修复 adapter 或显式重规划。

| 策略        | 认证来源                         | 典型成本                      |
| ----------- | -------------------------------- | ----------------------------- |
| `public`    | 无                               | 直接 fetch                    |
| `cookie`    | 一个声明的站点 credential source | 注入目标请求 header           |
| `header`    | Cookie + 自动抽 CSRF             | 抽取 CSRF，注入目标请求       |
| `intercept` | 浏览器在线会话                   | Navigate 页面，捕获 XHR/fetch |
| `ui`        | 浏览器在线会话                   | 点击、输入、snapshot          |

有界 HTTP probe 可以为诊断比较 `public`、`cookie` 与 `header`，但 command
execution 只运行声明的 strategy。普通 invocation 读取持久化 site credential；
`--auth-retry` 根据结构化失败显式选择唯一来源：`auth_required` 使用已选定的
local-browser profile，`challenge_required` 使用当前 live CDP target。新值由
一次性 opaque capability 绑定到一个新的、site/domain 匹配的 invocation。
miss、失败或 profile 歧义都会终止刷新，不会更换 credential authority。
Browser-backed strategy 必须由 operation 明确声明。

live browser/CDP 获取只停留在该 invocation 的 async context。只有显式执行
`auth import` 或 `browser cookies` 才会在 `~/.unicli/cookies/` 写入
plaintext JSON。

## v2 AgentEnvelope

每条经 CLI formatter 渲染的已注册 adapter command 都返回包含 success/failure arm
的 v2 AgentEnvelope。Agent
用一份 schema 解析静态 adapter catalog 中的
<span><!-- STATS:command_count -->1830<!-- /STATS --></span> 条命令；固定 core
命令与主机动态发现命令会在运行时单独列出。

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "hackernews.top",
  "meta": {
    "duration_ms": 412,
    "count": 5,
    "surface": "web"
  },
  "data": [
    /* 结果 */
  ],
  "error": null
}
```

失败时 `ok` 变 `false`、`data` 变 `null`，`error` 一定有 `code` 和 `message`；
其他 repair field 是条件字段。CLI 在 envelope 旁边把结构化失败映射为 process exit
class，JSON schema 本身不包含 `exit_code` 字段。

## Self-repair 闭环

这是让整套架构值得做的设计选择。当站点改版且 owned path 已知时，错误回执可以给
Agent 一条有界修复路径：

```json
{
  "ok": false,
  "schema_version": "2",
  "command": "twitter.search",
  "meta": { "duration_ms": 91, "surface": "web" },
  "data": null,
  "error": {
    "code": "not_found",
    "message": "HTTP 404 from the configured search endpoint",
    "adapter_path": "/Users/me/.unicli/adapters/twitter/search.yaml",
    "step": 0,
    "suggestion": "endpoint may have moved; check x.com/i/api/graphql/* in DevTools Network tab",
    "retryable": false,
    "alternatives": ["unicli twitter timeline @user", "unicli twitter trending"]
  }
}
```

这个例子包含要改的文件、失败 step、假设和 alternatives，是因为该失败类别能提供；
其他失败会省略不适用字段。改完 YAML，跑 `unicli repair twitter search`，由有界
子进程重跑原始 JSON command，并要求 envelope 与 exit code 一致。补丁存在
`~/.unicli/adapters/`，`npm update` 冲不掉。YAML 的经济性来自小而可检查的 source
change 与可执行 verification，不来自未经测量的通用时间倍率。

## 为什么 CLI 是原生运行入口

CLI 是原生完整 surface，而不是产品边界。任何能 spawn process 的 host 都能直接
调用。MCP 通过 default、deferred、expanded profile 暴露 adapter operation；ACP、
HTTP-compatible route 与 skill 是各自拥有支持子集的 integration，不应解读成逐命令 parity。

**按需上下文**。`search -> describe -> invoke` 让 subprocess host 只加载选中的 operation。[docs/BENCHMARK.md](/zh/BENCHMARK) 实测代表性 `--limit 5` 列表型 Uni-CLI 调用总预算为 364-423 token（中位 412）。这是 Uni-CLI fixture，不是第三方协议对比；default/deferred MCP profile 和现代 host-side tool search 同样可以按需加载 schema。

**可检查**。CLI 在熟悉的 process 边界上保留参数、stdout、stderr、exit status、environment 和文件 artifact。Network、browser、desktop effect 仍然有状态、非确定；Uni-CLI 不把它们重命名为纯函数。

**可组合**。Shell pipeline、文件、CI 和已有本地工具不用常驻 service 就能调用 CLI。已经拥有 protocol session 和 deferred tool discovery 的 host 里，MCP 反而是更强的组合 surface。

## MCP 仍然赢的场景

CLI 不是万能替代。MCP 在这几类场景通常更好：

- **有状态认证** — 长会话 OAuth 流、刷 token、绑定 session 的资源。
- **实时** — WebSocket 驱动的聊天平台、server-sent events、流式生成。
- **Host-native discovery** — MCP-capable runtime 内的 default meta-tool search 或 deferred tool loading。
- **远程执行边界** — 不应该被伪装成本地 subprocess 的 governed server。

生产级 Agent 栈通常两个都要。Uni-CLI 的 `unicli mcp serve` 用 default、deferred
与 expanded profile 暴露 adapter operation contract；固定 core command 在路线图
parity 工作完成前仍以 native CLI 为规范入口。

## 操作目录是一等公民

按意图搜索比按 prompt 枚举更省。`unicli search "find AI agent discussions on reddit"` 返回排序好的命令清单，附带参数、认证、示例输出。Agent 选一条跑，永远不需要枚举整个目录。token 开销保持低，是因为运行时加载目录索引，而不是加载目录正文。

## 串起来跑

典型的 Agent 跑法长这样：

```bash
# 1. 发现
$ unicli search "summarize today's Hacker News top stories"
  → 建议: unicli hackernews top -n 10
  → 接着:  unicli huggingface summarize -

# 2. 执行 + pipe
$ unicli hackernews top -n 10 -f json \
    | jq -r '.data[] | .title + "\n" + .url' \
    | unicli huggingface summarize - -f md

# 3. 失败时错误回执直接指向要修的 adapter
# 4. Agent 改 YAML，跑 `unicli repair` 重新验证
```

这是规范的完整暴露路径。Adapter operation contract 也能通过 MCP profile 运行；
ACP、HTTP、skill 与 CI 暴露各自记录过的支持子集。一种命令形状覆盖静态目录中的
<span><!-- STATS:site_count -->326<!-- /STATS --></span> 个 adapter 站点与
<span><!-- STATS:command_count -->1830<!-- /STATS --></span> 条已注册 adapter command；
固定 core 与主机动态发现 command 在运行时加入 native CLI。渲染调用共享 v2 成功/错误
envelope 形状；可选 evidence 与 repair field 取决于 operation 和失败类别。

## 延伸阅读

- [适配器格式](/zh/ADAPTER-FORMAT) — YAML 适配器 schema 的完整 reference。
- [Pipeline 参考](/zh/reference/pipeline) — 每一步的参数。
- [Self-Repair 指南](/zh/guide/self-repair) — 修复闭环的细节。
- [FAQ](/zh/faq) — 常见问题速答。
- [Glossary](/zh/glossary) — 本文用到的术语定义。
