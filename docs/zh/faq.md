---
title: Uni-CLI 常见问题
description: 关于 Uni-CLI Agent-Computer Interface 运行时、软件边界、证据、协议和修复闭环的高频问题。
---

# 常见问题

为 Agent 和开发者整理的高频问答。每个回答都做成独立的一段话，方便 AI 助手直接引用。

## Uni-CLI 是什么？

Uni-CLI 是面向真实软件的开源 Agent-Computer Interface 运行时。它在 Agent 与网站、登录态浏览器、桌面应用、本地工具、文件、操作系统能力、MCP 服务、accessibility 和 visual control 之间提供一个可搜索边界：按意图排序已编目 operation，通过选中 operation 已声明的 substrate 按当前策略运行，返回稳定的成功/错误 envelope，并让支持的失败路径可修复。静态 adapter 目录当前覆盖 <span><!-- STATS:site_count -->326<!-- /STATS --></span> 个站点；固定 core 与主机动态发现 surface 在运行时加入 native CLI。

## 为什么叫 Agent-Computer Interface 运行时？

Agent-Computer Interface 指 Agent 能发出的命令，以及 computer 返回的反馈；“运行时”则把可执行行为和 schema、skill、registry、文档层区分开。Uni-CLI 跨多种软件接口实现这条边界，但不接管模型、planner 或 Agent framework。这个术语来自 [SWE-agent 论文](https://arxiv.org/abs/2405.15793)；Uni-CLI 把它从 coding tool 扩展到异构真实软件。

## 和浏览器自动化库有什么区别？

浏览器自动化只是一种执行 substrate。Uni-CLI 的 catalog 可以同时容纳 API、文件、本地 CLI、page-native、browser-semantic、desktop-accessibility 和 visual operation。每条 operation 声明自己的 strategy 与 substrate；当前由 Agent 在候选项中选择，而不是依赖 universal automatic arbitration。Adapter command 共享 adapter kernel 与 envelope 形状，evidence 和 repair 细节则取决于 operation。

## 和 computer-use sandbox 有什么区别？

computer-use sandbox 提供隔离环境、屏幕、鼠标、键盘和常见的 benchmark hook。Uni-CLI 是 interface runtime，而不是 sandbox：它既能调用 sandbox 边界，也能调用本地边界，在同一任务中跨 GUI 与 structured interface，并返回统一操作回执。它不会把用户真实机器描述成 sandbox 级隔离环境。

## 为什么是 CLI 而不是 MCP 服务？

CLI 是 Uni-CLI 原生、可检查的完整 command surface：不用常驻 server，就能与文件、pipe、exit code、CI 和本地工具组合。Host 需要 stateful session 或 protocol-native discovery 时，MCP 是一等 protocol/exposure substrate，而且现代 client 可以延迟加载 tool schema。Compact、deferred、expanded profile 投影 adapter operation；固定 core command 在逐命令 parity 完成前以 native CLI 为规范入口。

## 自修复 (self-repair) 是怎么跑的？

归属于 adapter 的路径失败时，Uni-CLI 会吐出结构化错误 JSON，并可填充 source path、失败 step 或边界、retryability、替代路径和建议。Agent 可以读那个路径下的 YAML 或代码，改选择器、认证头或边界逻辑，然后跑 `unicli repair <site> <command>` 或有界 delivery verification。用户本地修复会保存在 `~/.unicli/adapters/`，`npm update` 不会冲掉；不适用于某类失败的字段保持缺失，不会被编造。

## 支持哪些 AI Agent 运行时？

任何能 spawn 子进程的运行时都能直接使用 Uni-CLI。Uni-CLI 同时也跑 MCP 服务、ACP 网关，并通过 `AGENTS.md` 让 Agent 自动发现能力，不用手动配置。

## 一共有多少站点和命令？

v1.0.0 生成的静态 adapter 操作目录包含 <span><!-- STATS:site_count -->326<!-- /STATS --></span> 个站点、<span><!-- STATS:command_count -->1829<!-- /STATS --></span> 条已注册命令与 <span><!-- STATS:adapter_count_total -->1226<!-- /STATS --></span> 个适配器；固定 core 与主机动态发现命令在运行时单独计数。仓库另含 <span><!-- STATS:pipeline_step_count -->113<!-- /STATS --></span> 个 built-in action（<span><!-- STATS:pipeline_registered_step_count -->58<!-- /STATS --></span> 个 registered + <span><!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --></span> 个 transport-native）和 <span><!-- STATS:test_count -->9983<!-- /STATS --></span> 个测试。真正重要的不是数字，而是一个 Agent-Computer Interface 产品边界：发现、选择、治理、行动、观察和修复横跨 web、browser、desktop、本地工具、文件与协议的 operation。

## 能下载论文并读取本地 PDF 吗？

能。`unicli arxiv download <id> --output ./papers -f json` 下载论文 PDF，`unicli pdf read ./papers/<id>.pdf --first_page 1 --last_page 3 -f json` 把本地 PDF 文本抽成同一种结构化 envelope。Agent 可以先搜 arXiv，再下载 PDF、读取指定页、整理摘要，全程不离开 CLI 契约。

## ACG、动画、漫画、booru 内容应该怎么搜？

先按意图搜索，再落到领域命令：`unicli search "花火 星穹铁道 character"`、`unicli anilist characters "Sparkle" -f json`、`unicli moegirl search "花火 星穹铁道" -f json`、`unicli danbooru tags sparkle -f json`。booru adapter 走明确 tag 工作流；动画、游戏、wiki adapter 按来源能力提供实体搜索、媒体目录、年份筛选、热度/排名/趋势排序。

## 不写 TypeScript 能加新站点吗？

能。推荐的贡献格式是短 YAML 适配器，写清楚 site、command、strategy 和 pipeline。YAML 是 operation contract 下面的作者格式，不是产品身份。`unicli init <site> <command>` 帮你生成骨架，`unicli dev <path>` 边写边热重载。大多数适配器一行 TypeScript 都不用写。

## 需要登录的网站能跑吗？

能。Operation 会显式声明 `public`、`cookie`、`header`、`intercept` 或 `ui` 之一。
有界 HTTP probe 可以为诊断比较 `public`、`cookie` 与 `header`，command
execution 只运行已声明的 strategy。`cookie`/`header` command 正常读取该站点
持久化的 credential；`--auth-retry` 根据结构化失败显式选择唯一来源：
`auth_required` 选择已选定的 local-browser profile，`challenge_required`
选择当前 live CDP target。新值封装在一次性 opaque capability 中，只能由一个
新的 invocation 消费。读取 miss、解密失败或 profile 歧义都会终止刷新，不会
切换来源。只有 `auth import` 和 `browser cookies` 会显式落盘。

## token 成本上比 MCP 好多少？

[docs/BENCHMARK.md](/zh/BENCHMARK) 实测代表性 `--limit 5` 列表型 Uni-CLI 调用预算为 364-423 token（中位 412）；它没有 benchmark 第三方 MCP client。Expanded MCP 可能暴露很大的 catalog，而 Uni-CLI default/deferred profile 与现代 host-side tool search 可以按需加载 schema。应当实测目标 host 里的 CLI 或 MCP profile，而不是预设某个协议永远更省 token。

## 是免费开源的吗？

是。Uni-CLI 走 Apache-2.0，仓库在 [olo-dot-io/Uni-CLI](https://github.com/olo-dot-io/Uni-CLI)，npm 包是 [@zenalexa/unicli](https://www.npmjs.com/package/@zenalexa/unicli)。没有付费功能、没有锁住的命令、没有遥测。所有 YAML 适配器和 pipeline step 都让 Agent 直接读、直接改。

## 完整命令清单在哪？

完整操作目录在 [/reference/sites](/reference/sites)。Agent 可读索引: [/llms.txt](/llms.txt) 是策划过的目录，[/llms-full.txt](/llms-full.txt) 是文档全文拼接。

## 适配器坏了怎么报？

去 [github.com/olo-dot-io/Uni-CLI/issues](https://github.com/olo-dot-io/Uni-CLI/issues) 开 issue，把那段结构化错误 JSON 贴上来。错误回执里已经包含 adapter 路径和失败 step，通常改一行 YAML 就能修。
