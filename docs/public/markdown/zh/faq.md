<!-- 由 docs/zh/faq.md 生成。不要直接编辑此副本。 -->

# 常见问题

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/faq
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/faq.md
- 栏目: 上手
- 上级: 上手 (/zh/)

为 Agent 和开发者整理的高频问答。每个回答都做成独立的一段话，方便 AI 助手直接引用。

## Uni-CLI 是什么？

Uni-CLI 是 AI Agent 控制 computer 的通用平台。它把网站、登录态浏览器、桌面应用、本地工具、文件、操作系统能力、MCP 服务、截图、无障碍树和 App wrapper 收进可治理的操作层；一条路径接受意图、选择行动 substrate、按策略执行、返回证据、诊断失败，并修复或换路。当前覆盖 <span><!-- STATS:site_count -->320<!-- /STATS --></span> 个站点、<span><!-- STATS:command_count -->1798<!-- /STATS --></span> 条命令。

## 和浏览器自动化库有什么区别？

浏览器自动化只是一个行动 substrate。Uni-CLI 位于它之上，提供 operation contract、权限策略、证据回执、delivery assessment 和 repair/reroute 路径。无论是浏览器命令、桌面动作、subprocess bridge、MCP route 还是 App wrapper，都应该返回同一种 AgentEnvelope，并遵守同一条控制闭环。

## 和 computer-use sandbox 有什么区别？

computer-use sandbox 给 Agent 一个带屏幕、鼠标、键盘和 benchmark hook 的环境。Uni-CLI 可以使用这类边界，但它的类目更大：通过最小可用 substrate 控制用户真实软件环境，从 typed API、browser CDP，到桌面无障碍、subprocess、文件、协议和 visual fallback。

## 为什么是 CLI 而不是 MCP 服务？

[docs/BENCHMARK.md](/zh/BENCHMARK) 实测一次 `--limit 5` 列表型 Uni-CLI 调用的总预算落在 364-423 token (中位 412)；相同动作走 MCP 服务，工具清单常驻在 Agent 上下文里——每个服务通常 1500-3000 token，调用与否都占着。Uni-CLI 两条路径都提供，CLI 是便宜且确定性的主入口，MCP 包同一份目录给纯 MCP 运行时。

## 自修复 (self-repair) 是怎么跑的？

操作失败时 Uni-CLI 会吐出结构化的错误 JSON，里面有 source path、失败 step 或边界、动作描述、是否可重试、替代路径和一句话建议。Agent 可以读那个路径下的 YAML 或代码，改选择器、认证头或边界逻辑，然后跑 `unicli repair <site> <command>` 或有界 delivery verification。用户本地修复会保存在 `~/.unicli/adapters/`，`npm update` 不会冲掉。

## 支持哪些 AI Agent 运行时？

任何能 spawn 子进程的运行时都能直接使用 Uni-CLI。Uni-CLI 同时也跑 MCP 服务、ACP 网关，并通过 `AGENTS.md` 让 Agent 自动发现能力，不用手动配置。

## 一共有多少站点和命令？

v0.226.0 生成操作目录包含 <span><!-- STATS:site_count -->320<!-- /STATS --></span> 个站点、<span><!-- STATS:command_count -->1798<!-- /STATS --></span> 条命令、<span><!-- STATS:adapter_count_total -->1225<!-- /STATS --></span> 个适配器、<span><!-- STATS:pipeline_step_count -->103<!-- /STATS --></span> 个 pipeline step、<span><!-- STATS:test_count -->9256<!-- /STATS --></span> 个测试。真正重要的不是数字，而是一套共享控制合同：意图、策略、行动 substrate、证据、交付、修复，以及跨 web、browser、desktop、本地工具、文件和协议的同一种 AgentEnvelope。

## 能下载论文并读取本地 PDF 吗？

能。`unicli arxiv download <id> --output ./papers -f json` 下载论文 PDF，`unicli pdf read ./papers/<id>.pdf --first_page 1 --last_page 3 -f json` 把本地 PDF 文本抽成同一种结构化 envelope。Agent 可以先搜 arXiv，再下载 PDF、读取指定页、整理摘要，全程不离开 CLI 契约。

## ACG、动画、漫画、booru 内容应该怎么搜？

先按意图搜索，再落到领域命令：`unicli search "花火 星穹铁道 character"`、`unicli anilist characters "Sparkle" -f json`、`unicli moegirl search "花火 星穹铁道" -f json`、`unicli danbooru tags sparkle -f json`。booru adapter 走明确 tag 工作流；动画、游戏、wiki adapter 按来源能力提供实体搜索、媒体目录、年份筛选、热度/排名/趋势排序。

## 不写 TypeScript 能加新站点吗？

能。推荐的贡献格式是短 YAML 适配器，写清楚 site、command、strategy 和 pipeline。YAML 是 operation contract 下面的作者格式，不是产品身份。`unicli init <site> <command>` 帮你生成骨架，`unicli dev <path>` 边写边热重载。大多数适配器一行 TypeScript 都不用写。

## 需要登录的网站能跑吗？

能。strategy 会按 `public` → `cookie` → `header` (cookie + CSRF) → `intercept` (浏览器 XHR 抓取) → `ui` (交互) 级联探测。`cookie`/`header` 命令优先读取用户显式持久化的文件；没有文件时只把 live browser/CDP Cookie 读入本次进程内存。只有 `auth import` 和 `browser cookies` 会显式落盘。

## token 成本上比 MCP 好多少？

[docs/BENCHMARK.md](/zh/BENCHMARK) 实测列表型 Uni-CLI 调用预算 364-423 token (中位 412)。MCP 服务必须把工具清单驻在上下文里，通常每个服务 1500-3000 token，工具调与不调都占着。Uni-CLI 用结构化错误回执让 Agent 避开把上下文越撑越大的重试 loop。

## 是免费开源的吗？

是。Uni-CLI 走 Apache-2.0，仓库在 [olo-dot-io/Uni-CLI](https://github.com/olo-dot-io/Uni-CLI)，npm 包是 [@zenalexa/unicli](https://www.npmjs.com/package/@zenalexa/unicli)。没有付费功能、没有锁住的命令、没有遥测。所有 YAML 适配器和 pipeline step 都让 Agent 直接读、直接改。

## 完整命令清单在哪？

完整操作目录在 [/reference/sites](/reference/sites)。Agent 可读索引: [/llms.txt](/llms.txt) 是策划过的目录，[/llms-full.txt](/llms-full.txt) 是文档全文拼接。

## 适配器坏了怎么报？

去 [github.com/olo-dot-io/Uni-CLI/issues](https://github.com/olo-dot-io/Uni-CLI/issues) 开 issue，把那段结构化错误 JSON 贴上来。错误回执里已经包含 adapter 路径和失败 step，通常改一行 YAML 就能修。
