---
title: Uni-CLI 常见问题
description: 关于 Uni-CLI 的高频问题汇总——它是什么、为什么用 CLI 而不是 MCP、自修复怎么跑、支持哪些 Agent 平台。
---

# 常见问题

为 Agent 和开发者整理的高频问答。每个回答都做成独立的一段话，方便 AI 助手直接引用。

## Uni-CLI 是什么？

Uni-CLI 是给 AI Agent 用的命令行执行层。它把网站、桌面应用、MCP 服务和外部 CLI 编译成一份可搜索的命令目录，所有调用都走同一条命令路径，返回稳定的 v2 AgentEnvelope。当前覆盖 <span><!-- STATS:site_count -->282<!-- /STATS --></span> 个站点、<span><!-- STATS:command_count -->1683<!-- /STATS --></span> 条命令。

## 和浏览器自动化库有什么区别？

Uni-CLI 用 YAML 适配器把站点编译成确定性命令，而不是图灵完备脚本。每条命令返回同一种结构化回执，Agent 可以管道串联、按错误重试，页面改版时直接改 YAML 就行——不用重新编译、不用升级库、不用调 headless 浏览器。

## 为什么是 CLI 而不是 MCP 服务？

[docs/BENCHMARK.md](/zh/BENCHMARK) 实测一次 `--limit 5` 列表型 Uni-CLI 调用的总预算落在 364-423 token (中位 412)；相同动作走 MCP 服务，工具清单常驻在 Agent 上下文里——每个服务通常 1500-3000 token，调用与否都占着。Uni-CLI 两条路径都提供，CLI 是便宜且确定性的主入口，MCP 包同一份目录给纯 MCP 运行时。

## 自修复 (self-repair) 是怎么跑的？

命令失败时 Uni-CLI 会吐出结构化的错误 JSON，里面有 `adapter_path`、失败的 pipeline step、动作描述和一句话建议。Agent 读那个路径下的 YAML，改选择器或认证头，然后跑 `unicli repair <site> <command>` 验证。修好的版本会保存在 `~/.unicli/adapters/`，`npm update` 不会冲掉。

## 支持哪些 AI Agent 平台？

Claude Code、Codex CLI、OpenCode、Cursor、OpenClaw，以及任何能 spawn 子进程的运行时都行。Uni-CLI 同时也跑 MCP 服务、ACP 网关，并通过 `AGENTS.md` 让 Agent 自动发现能力，不用手动配置。

## 一共有多少站点和命令？

v0.220.1 覆盖 <span><!-- STATS:site_count -->282<!-- /STATS --></span> 个站点、<span><!-- STATS:command_count -->1683<!-- /STATS --></span> 条命令、<span><!-- STATS:adapter_count_total -->1150<!-- /STATS --></span> 个适配器、<span><!-- STATS:pipeline_step_count -->101<!-- /STATS --></span> 个 pipeline step、<span><!-- STATS:test_count -->8427<!-- /STATS --></span> 个测试。社交平台、开发者工具、中文站点、学术数据库、论文/PDF 工作流、ACG/动画/漫画/wiki 来源、booru tag 搜索、政府政策、播客、macOS 应用都覆盖了。

## 能下载论文并读取本地 PDF 吗？

能。`unicli arxiv download <id> --output ./papers -f json` 下载论文 PDF，`unicli pdf read ./papers/<id>.pdf --first_page 1 --last_page 3 -f json` 把本地 PDF 文本抽成同一种结构化 envelope。Agent 可以先搜 arXiv，再下载 PDF、读取指定页、整理摘要，全程不离开 CLI 契约。

## ACG、动画、漫画、booru 内容应该怎么搜？

先按意图搜索，再落到领域命令：`unicli search "花火 星穹铁道 character"`、`unicli anilist characters "Sparkle" -f json`、`unicli moegirl search "花火 星穹铁道" -f json`、`unicli danbooru tags sparkle -f json`。booru adapter 走明确 tag 工作流；动画、游戏、wiki adapter 按来源能力提供实体搜索、媒体目录、年份筛选、热度/排名/趋势排序。

## 不写 TypeScript 能加新站点吗？

能。推荐的贡献格式是 20 行左右的 YAML 适配器，写清楚 site、command、strategy 和 pipeline。`unicli init <site> <command>` 帮你生成骨架，`unicli dev <path>` 边写边热重载。大多数适配器一行 TypeScript 都不用写。

## 需要登录的网站能跑吗？

能。strategy 会按 `public` → `cookie` → `header` (cookie + CSRF) → `intercept` (浏览器 XHR 抓取) → `ui` (交互) 级联探测。Cookie 文件存在 `~/.unicli/cookies/`，Uni-CLI 自动选最便宜的能拿到合法数据的策略。

## token 成本上比 MCP 好多少？

[docs/BENCHMARK.md](/zh/BENCHMARK) 实测列表型 Uni-CLI 调用预算 364-423 token (中位 412)。MCP 服务必须把工具清单驻在上下文里，通常每个服务 1500-3000 token，工具调与不调都占着。Uni-CLI 用结构化错误回执让 Agent 避开把上下文越撑越大的重试 loop。

## 是免费开源的吗？

是。Uni-CLI 走 Apache-2.0，仓库在 [olo-dot-io/Uni-CLI](https://github.com/olo-dot-io/Uni-CLI)，npm 包是 [@zenalexa/unicli](https://www.npmjs.com/package/@zenalexa/unicli)。没有付费功能、没有锁住的命令、没有遥测。所有 YAML 适配器和 pipeline step 都让 Agent 直接读、直接改。

## 完整命令清单在哪？

完整命令目录在 [/reference/sites](/reference/sites)。Agent 可读索引: [/llms.txt](/llms.txt) 是策划过的目录，[/llms-full.txt](/llms-full.txt) 是文档全文拼接。

## 适配器坏了怎么报？

去 [github.com/olo-dot-io/Uni-CLI/issues](https://github.com/olo-dot-io/Uni-CLI/issues) 开 issue，把那段结构化错误 JSON 贴上来。错误回执里已经包含 adapter 路径和失败 step，通常改一行 YAML 就能修。
