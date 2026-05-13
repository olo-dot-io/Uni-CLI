---
title: Uni-CLI 工作原理
description: Uni-CLI 执行模型的深度解读——YAML 适配器格式、v2 AgentEnvelope、策略级联、pipeline，以及让 Agent 自己修复集成的 self-repair 闭环。
---

# Uni-CLI 工作原理

Uni-CLI 是给 AI Agent 用的命令行执行层。它把网站、桌面应用、MCP 服务、外部 CLI 编译成一份可搜索的命令目录。这一页讲清楚整套架构：YAML 适配器是怎么编译成 CLI 命令的，策略级联怎么解决认证，v2 AgentEnvelope 怎么把证据回执给 Agent，以及当站点改版时 self-repair 闭环是怎么收住的。

## 四段契约

每条 Uni-CLI 命令都走同样的四个阶段。Agent 可以在任何阶段停下来推理。

1. **发现**：`unicli search "<意图>"` 走本地双语 BM25 排序，返回站点、命令、参数、认证策略和输出 schema。
2. **执行**：`unicli <site> <command> [args]` 跑 YAML pipeline，返回 v2 AgentEnvelope。
3. **恢复**：失败回执是 `{ adapter_path, step, action, suggestion, retryable, alternatives }`，给 Agent 一条有界的修复路径。
4. **修复**：Agent 改 `adapter_path` 处的 YAML，跑 `unicli repair <site> <command>` 验证补丁。

五种适配器类型 (web-api、browser、desktop、bridge、service) 都遵守同一份契约。

## 领域感知发现

目录搜索不是单纯按站点名匹配。它把双语 BM25、命令元数据、alias 和领域词表合在一起，让 Agent 先搜实体，再选择合适表面。例如 `花火 星穹铁道 character` 会更容易落到角色/wiki/动画来源，`blue_archive rating:safe` 会更容易落到 booru tag 搜索。日文名、罗马音、中文名、英文名作为相关 adapter 表面的 alias 维护，而不是写成一次性的站点捷径。

同一条规则也避免泛查询被误导。只有查询里明确出现 ACG、论文、wiki、tag、游戏、动画、漫画、美少女游戏等领域词时，领域 boost 才生效；普通查询仍然按 Web、开发、财经或 App 命令自己的证据排序。

## YAML 适配器格式

集成的最小单位是一份 20 行 YAML。下面是一个公开 RSS 订阅的完整适配器：

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

五个字段定义契约：`site` (集成名)、`name` (命令)、`type` (面向哪个表面 — web-api / browser / desktop / bridge / service)、`strategy` (认证路径)、`pipeline` (产出结果的步骤)。零 import、零 class、零编译——Agent 直接读、直接改选择器、几秒就验证完。

## <span><!-- STATS:pipeline_step_count -->101<!-- /STATS --></span> 步 pipeline

所有适配器共用同一份 <span><!-- STATS:pipeline_step_count -->101<!-- /STATS --></span> 步 pipeline 注册表。步骤按用途分组：API 拉取、变换、浏览器、桌面、媒体、控制流、断言。每步都是确定性的——同样输入产出同样输出——所以适配器组合起来就是稳定的执行图。

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

| 策略        | 认证来源                        | 典型成本                      |
| ----------- | ------------------------------- | ----------------------------- |
| `public`    | 无                              | 直接 fetch                    |
| `cookie`    | `~/.unicli/cookies/<site>.json` | 注入 header                   |
| `header`    | Cookie + 自动抽 CSRF            | 从 cookie 抽 CSRF，注入请求   |
| `intercept` | 浏览器在线会话                  | Navigate 页面，捕获 XHR/fetch |
| `ui`        | 浏览器在线会话                  | 点击、输入、snapshot          |

级联顺序是 `public → cookie → header → intercept → ui`。某站第一次跑时，Uni-CLI 逐个试，直到某个策略返回可解析数据，然后缓存结果。后面的调用跳过探测。

## v2 AgentEnvelope

每条命令都返回 v2 AgentEnvelope——成功失败同一个形状。Agent 用一份 schema 解析 <span><!-- STATS:command_count -->1680<!-- /STATS --></span> 条命令。

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

## 为什么 CLI 是 Agent 工具的正确形状

三股力量让 CLI 成为 Agent 工具更便宜的主入口。

**Token 经济**。[docs/BENCHMARK.md](/zh/BENCHMARK) 实测 `--limit 5` 列表型适配器的总调用预算 364-423 token (中位 412)。MCP 服务把工具清单常驻在 Agent 上下文里，每个服务通常 1500-3000 token，调用与否都占着。CLI 按用量付费；MCP 服务为"可用"付费。

**确定性**。一次 CLI 调用是参数和时间的纯函数。同样参数、同一分钟、同样输出。MCP roundtrip 多了一个有状态服务、一层传输、一层协议，会漂移。对 Agent 自动化来说，少一处变动就少一类故障。

**可组合**。Shell pipeline 是自动化通用语。`unicli reddit hot r/programming -n 50 -f json | jq '.data[].title' | unicli huggingface summarize -` 装好 Uni-CLI 当天就能跑。同样的组合走 MCP 还得加一层胶水代码。

## MCP 仍然赢的场景

CLI 不是万能替代。MCP 在这几类场景仍然更好：

- **有状态认证** — 长会话 OAuth 流、刷 token、绑定 session 的资源。
- **实时** — WebSocket 驱动的聊天平台、server-sent events、流式生成。
- **垂直深度集成** — 厂商自己出的 MCP 服务，通常比第三方 CLI 适配器在那个垂直平台上更强。

生产级 Agent 栈通常两个都要。Uni-CLI 自带一个 MCP 网关 (`unicli mcp serve`) 包了同一份目录，纯 MCP 运行时不用做第二次集成就拿到同一套执行表面。

## 目录是一等公民

按意图搜索比按 prompt 枚举更省。`unicli search "find AI agent discussions on reddit"` 返回排序好的命令清单，附带参数、认证、示例输出。Agent 选一条跑，永远不需要枚举整个目录。Apideck CLI 和 OnlyCLI 报告 96-99% 的 token 节省都是这个套路——加载目录索引，不是目录本身。

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

这就是整套交互模型。一种命令形状跨 <span><!-- STATS:site_count -->282<!-- /STATS --></span> 个站点、<span><!-- STATS:command_count -->1680<!-- /STATS --></span> 条命令。一种错误回执跨每一次失败。一条 self-repair 路径跨每一个适配器。

## 延伸阅读

- [适配器格式](/zh/ADAPTER-FORMAT) — YAML 适配器 schema 的完整 reference。
- [Pipeline 参考](/zh/reference/pipeline) — 每一步的参数。
- [Self-Repair 指南](/zh/guide/self-repair) — 修复闭环的细节。
- [理论](/zh/THEORY) — CS 理论支撑 (Rice 限制、Lehman 命令、Banach 收敛、Agent 工具三难)。
- [FAQ](/zh/faq) — 常见问题速答。
- [Glossary](/zh/glossary) — 本文用到的术语定义。
