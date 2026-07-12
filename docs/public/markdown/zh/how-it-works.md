<!-- 由 docs/zh/how-it-works.md 生成。不要直接编辑此副本。 -->

# 工作原理

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/how-it-works
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/how-it-works.md
- 栏目: 上手
- 上级: 上手 (/zh/)

Uni-CLI 是 AI Agent 控制 computer 的通用平台。它把网站、登录态浏览器、桌面应用、本地工具、文件、操作系统能力、MCP 服务、外部 CLI、无障碍树、截图和 App wrapper 收进同一套可治理的操作层。这一页讲清楚控制闭环：意图怎样变成 operation contract，Uni-CLI 怎样选择行动 substrate，v2 AgentEnvelope 怎样返回证据，以及真实软件变化时 delivery/repair 怎样维持路径。

## Computer-Control 契约

每条 Uni-CLI 操作都走同一条产品闭环。Agent 可以在任何阶段停下来推理。

1. **意图**：`unicli search "<意图>"` 和 `unicli do "<意图>"` 把任务映射成候选操作、参数、认证姿态、样例和风险信号。
2. **选择**：operation contract 选择能行动的最小边界：API、browser、desktop accessibility、subprocess、protocol、visual fallback 或 App wrapper。
3. **治理**：permission profile、deny rule、capability scope、本地策略在请求、写入、启动进程或 UI 动作前拦住高风险影响。
4. **行动**：共享 control kernel 调用选中的 substrate，而不是让 CLI、MCP、ACP 或文档各自定义行为。
5. **观察**：AgentEnvelope v2 用同一种形状返回 data、context、retryability、耗时和证据 hook，成功失败都一样。
6. **诊断**：delivery assessment 把失败归为认证、策略、缺少上下文、上游漂移、环境问题或 adapter 缺陷。
7. **修复或换路**：下一次实验受 source path、alternatives、evidence 和 verification command 约束。
8. **交付**：evidence gate 判断目标已满足、仍在进行、被阻断，还是已经耗尽。
9. **暴露**：同一条操作可以复用到 native CLI、JSON stream、MCP、ACP、HTTP、docs、skills、CI 和脚本。

这份契约横跨所有行动 substrate。adapter type 是产品边界之下的实现细节。

## Substrate 不是身份

浏览器自动化、computer-use sandbox、自然语言本地执行、MCP 服务和单站点 wrapper 都有价值，但它们不是 Uni-CLI 的类目。它们是 Uni-CLI 可以使用或暴露的具体技术边界。

| Substrate       | 贡献什么                                           | Uni-CLI 在它上面保留什么                       |
| --------------- | -------------------------------------------------- | ---------------------------------------------- |
| Web/API         | typed fetch、cookie/header auth、download、extract | operation contract、policy、evidence、repair   |
| Browser         | CDP 控制、DOM/accessibility ref、截图、网络捕获    | 选择、回执、交付、换路                         |
| Desktop/OS      | installed app、无障碍树、截图、本地状态            | governed action、post-state evidence、平台诊断 |
| 本地工具/文件   | subprocess、PDF、媒体工具、开发者 CLI              | typed args、output envelope、retryability      |
| 协议            | MCP、ACP、Streamable HTTP、JSON stream             | 共享语义，不让 wrapper 各自定义行为            |
| Visual fallback | 最后一公里屏幕交互                                 | 真实性闸门：能看见、能行动、能验证             |

## 领域感知发现

目录搜索不是单纯按站点名匹配。它把双语 BM25、命令元数据、alias 和领域词表合在一起，让 Agent 先搜实体，再选择合适表面。例如 `花火 星穹铁道 character` 会更容易落到角色/wiki/动画来源，`blue_archive rating:safe` 会更容易落到 booru tag 搜索。日文名、罗马音、中文名、英文名作为相关 adapter 表面的 alias 维护，而不是写成一次性的站点捷径。

同一条规则也避免泛查询被误导。只有查询里明确出现 ACG、论文、wiki、tag、游戏、动画、漫画、美少女游戏等领域词时，领域 boost 才生效；普通查询仍然按 Web、开发、财经或 App 命令自己的证据排序。

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

所有适配器共用同一份 <span><!-- STATS:pipeline_step_count -->103<!-- /STATS --></span> 步 pipeline 注册表。步骤按用途分组：API 拉取、变换、浏览器、桌面、媒体、控制流、断言。每步都是确定性的——同样输入产出同样输出——所以适配器组合起来就是稳定的执行图。

| 类别   | 示例                                                                | 用途                  |
| ------ | ------------------------------------------------------------------- | --------------------- |
| API    | `fetch`、`fetch_text`、`parse_rss`、`html_to_md`                    | HTTP 拉取与结构化抽取 |
| 变换   | `select`、`map`、`filter`、`sort`、`limit`                          | 在步骤之间变形 JSON   |
| 浏览器 | `navigate`、`evaluate`、`click`、`type`、`wait`、`intercept`、`tap` | 通过 CDP 控制 Chrome  |
| 桌面   | `exec`、`write_temp`                                                | 子进程控制            |
| 媒体   | `download`、`websocket`                                             | 文件和流式抓取        |
| 控制   | `set`、`if`、`each`、`parallel`、`rate_limit`、`assert`、`retry`    | 组合原语              |
| 输出   | `extract`、columns                                                  | 给 Agent 的最终形状   |

Pipeline 自上而下走，共享一个 context 对象。每步读 `ctx.data`、写回。模板 (`${{ item.field }}`) 从前一步输出里取值。

## 策略级联

认证是接触现代 web 时最脏的部分。每个适配器声明五种策略之一，Uni-CLI 自动探测最便宜的能跑通的策略。

| 策略        | 认证来源                         | 典型成本                      |
| ----------- | -------------------------------- | ----------------------------- |
| `public`    | 无                               | 直接 fetch                    |
| `cookie`    | 显式文件或 live browser/CDP 内存 | 注入目标请求 header           |
| `header`    | Cookie + 自动抽 CSRF             | 抽取 CSRF，注入目标请求       |
| `intercept` | 浏览器在线会话                   | Navigate 页面，捕获 XHR/fetch |
| `ui`        | 浏览器在线会话                   | 点击、输入、snapshot          |

级联顺序是 `public → cookie → header → intercept → ui`。某站第一次跑时，Uni-CLI 逐个试，直到某个策略返回可解析数据，然后缓存结果。后面的调用跳过探测。

live browser/CDP 获取只停留在本次进程内存。只有显式执行 `auth import` 或
`browser cookies` 才会在 `~/.unicli/cookies/` 写入 plaintext JSON。

## v2 AgentEnvelope

每条命令都返回 v2 AgentEnvelope——成功失败同一个形状。Agent 用一份 schema 解析 <span><!-- STATS:command_count -->1798<!-- /STATS --></span> 条命令。

```json
{
  "ok": true,
  "version": "v2",
  "data": [
    /* 结果 */
  ],
  "meta": {
    "site": "reddit",
    "command": "search",
    "strategy": "public",
    "duration_ms": 412,
    "adapter_path": "/Users/me/.unicli/adapters/reddit/search.yaml"
  },
  "exit_code": 0
}
```

失败时 `ok` 变 `false`、`data` 变 `null`、`error` 填上结构化字段。退出码遵循 `sysexits.h` (0=ok、1=error、2=usage、66=empty、69=unavailable、75=temp、77=auth、78=config)，shell pipeline 可以按失败类别路由。

## Self-repair 闭环

这是让整套架构值得做的设计选择。当站点改版时，错误回执给 Agent 一条有界的修复路径：

```json
{
  "ok": false,
  "version": "v2",
  "data": null,
  "error": {
    "adapter_path": "/Users/me/.unicli/adapters/twitter/search.yaml",
    "step": "fetch",
    "action": "request returned 404",
    "suggestion": "endpoint may have moved; check x.com/i/api/graphql/* in DevTools Network tab",
    "retryable": false,
    "alternatives": ["unicli twitter timeline @user", "unicli twitter trending"]
  },
  "exit_code": 69
}
```

Agent 拿到的信息很完整：要改的文件、失败的 step、一句话假设、至少一条备选路径。改完 YAML，跑 `unicli repair twitter search` 用已知好的 fixture 重跑失败 step。补丁存在 `~/.unicli/adapters/`，`npm update` 冲不掉。

人调试要 30 分钟的 bug，Agent 30 秒就闭环了。两个数量级的差距，就是把适配器写成 YAML 全部经济性论证的核心。

## 为什么 CLI 是第一运行入口

CLI 是很多 Agent 运行里成本最低的第一暴露面，但它不是产品边界。三股力量让它适合作为第一运行入口。

**Token 经济**。[docs/BENCHMARK.md](/zh/BENCHMARK) 实测 `--limit 5` 列表型适配器的总调用预算 364-423 token (中位 412)。MCP 服务把工具清单常驻在 Agent 上下文里，每个服务通常 1500-3000 token，调用与否都占着。CLI 按用量付费；MCP 服务为"可用"付费。

**确定性**。一次 CLI 调用是参数和时间的纯函数。同样参数、同一分钟、同样输出。MCP roundtrip 多了一个有状态服务、一层传输、一层协议，会漂移。对 Agent 自动化来说，少一处变动就少一类故障。

**可组合**。Shell pipeline 是自动化通用语。`unicli reddit hot r/programming -n 50 -f json | jq '.data[].title' | unicli huggingface summarize -` 装好 Uni-CLI 当天就能跑。同样的组合走 MCP 还得加一层胶水代码。

## MCP 仍然赢的场景

CLI 不是万能替代。MCP 在这几类场景仍然更好：

- **有状态认证** — 长会话 OAuth 流、刷 token、绑定 session 的资源。
- **实时** — WebSocket 驱动的聊天平台、server-sent events、流式生成。
- **垂直深度集成** — 厂商自己出的 MCP 服务，通常比第三方 CLI 适配器在那个垂直平台上更强。

生产级 Agent 栈通常两个都要。Uni-CLI 自带一个 MCP 网关 (`unicli mcp serve`) 包了同一份目录，纯 MCP 运行时不用做第二次集成就拿到同一套执行表面。

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

这是最简单的暴露路径。同一份 operation contract 也可以通过 MCP、ACP、HTTP、skills 或 CI 运行，语义不变。一种命令形状跨 <span><!-- STATS:site_count -->320<!-- /STATS --></span> 个站点、<span><!-- STATS:command_count -->1798<!-- /STATS --></span> 条命令。一种错误回执跨每一次失败。一条 self-repair 路径跨每一个适配器。

## 延伸阅读

- [适配器格式](/zh/ADAPTER-FORMAT) — YAML 适配器 schema 的完整 reference。
- [Pipeline 参考](/zh/reference/pipeline) — 每一步的参数。
- [Self-Repair 指南](/zh/guide/self-repair) — 修复闭环的细节。
- [FAQ](/zh/faq) — 常见问题速答。
- [Glossary](/zh/glossary) — 本文用到的术语定义。
