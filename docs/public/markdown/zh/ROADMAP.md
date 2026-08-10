<!-- 由 docs/zh/ROADMAP.md 生成。不要直接编辑此副本。 -->

# 路线图

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/ROADMAP
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/ROADMAP.md
- 栏目: 项目
- 上级: 项目 (/zh/ARCHITECTURE)

当前版本：v1.0.4 — Artemis · Glover。

静态目录包含 <!-- STATS:site_count -->337<!-- /STATS --> 个站点。

它包含 <!-- STATS:command_count -->1884<!-- /STATS --> 条注册命令。运行时还会加入 core 与主机发现的命令。

## 已完成

- 本地中英文 operation search 与 command contract
- v2 success 和 error envelope
- Web、browser、desktop、local-tool、file 与 protocol operator
- Browser profile、session、target 和前后台 visibility
- Desktop accessibility 与 visual provider routing
- 本机 permission profile、approval 与 run record
- YAML adapter 开发、user adapter 与 repair verification
- CLI、MCP 与 ACP 入口
- 生成式操作目录和双语文档

## 进行中

### Contract 一致性

Core command 与 adapter command 正在统一到一套 operation contract，并覆盖 CLI、MCP、ACP、dry-run、生成的 Agent 文件和文档。

### 浏览器与桌面可靠性

当前重点是稳定的后台浏览器控制、清晰的 provider health、持久 target ownership，以及常用桌面应用的可重复 accessibility 路径。

### Action 后的结果证据

Mutating operation 正在补充更清晰的 post-action state、effect status 与 run comparison，让 Agent 可以区分已发起和已观察到的结果。

### Adapter 开发

开发流程会继续缩短 scaffold，复用 site note，提供聚焦 fixture，并让 repair output 可以直接交给 coding agent 使用。

### 精简发现

Search、deferred MCP tool 和生成的 Agent index 会继续优化，让大型目录保持可用，同时减少载入完整 manifest 的需求。

## 后续方向

- 更多 page-native 与 App-specific operator
- 更广的 Windows 与 Linux 桌面覆盖
- 能映射到 operation contract 的其他 registry input
- 面向长任务的 replay 与 comparison

## 如何安排优先级

能改善真实 operation path、共享合同或失败诊断能力的项目会优先推进。历史版本记录见 [CHANGELOG.md](https://github.com/olo-dot-io/Uni-CLI/blob/main/CHANGELOG.md)。
