<!-- 由 docs/zh/index.md 生成。不要直接编辑此副本。 -->

# 概览

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/index.md
- 栏目: 开始

## 面向真实软件的 Agent 执行底座。

按意图发现命令，跨 Web、应用、本地工具和系统能力执行可治理操作，再返回带证据的 AgentEnvelope，方便智能体检查和修复。

## 主要入口

- [快速开始](/zh/guide/getting-started)
- [浏览站点](/zh/reference/sites)

## 核心能力

- **按意图发现.** 双语 BM25 把自然语言映射到 235 个站点、1448 条可运行命令。
- **执行真实表面.** 同一套 CLI 覆盖 Web API、浏览器自动化、macOS 应用、桌面工具、本地服务和外部 CLI。
- **返回 AgentEnvelope.** Markdown、JSON、YAML、CSV 和 compact 输出共用同一套 v2 成功/错误合同。
- **治理副作用.** Operation policy 通过 open、confirm、locked profile 暴露 effect、risk、approval 和 capability scope。
- **记录证据.** 可选 run trace 和浏览器动作证据让执行过程可审查，同时不改变命令合同。
- **就地修复.** 失败结果会带上 adapter path、pipeline step、是否可重试、建议和替代命令。
- **接入智能体.** 命令行执行对 coding agent 是原生路径；MCP、ACP 和 JSON stream 是兼容接口。

## 当前版本

v1.0.0（Apollo · Lovell）已于 2026-04-28 发布到 npm，@zenalexa/unicli 的 latest 当前指向这个版本。

当前公开目录：235 个站点，1448 条命令。

### 更新提示

- 首个稳定执行底座版本，面向 Agent 驱动的 Web、应用、本地工具、系统能力和外部 CLI 操作。
- 公开合同固定为命令优先发现、v2 AgentEnvelope 输出、可修复 adapter 错误、operation policy metadata 和可选 run recording。
- 浏览器动作可以输出结构化前后证据、移动检测、stale-ref 失败细节和 watchdog 结果。
- 公开文档目录已更新到当前 235 个站点、1448 条命令、1039 个 adapter、59 个 step、7473 个测试。

### 链接

- [@zenalexa/unicli on npm](https://www.npmjs.com/package/@zenalexa/unicli)
- [GitHub Release v1.0.0](https://github.com/olo-dot-io/Uni-CLI/releases/tag/v1.0.0)
- [Changelog](https://github.com/olo-dot-io/Uni-CLI/blob/main/CHANGELOG.md#100--2026-04-28--apollo--lovell)

## 目录快照

- 站点：235
- 命令：1448
- 接口类型：5
- AgentEnvelope：v2

| 接口类型 | 站点数 |
| --- | ---: |
| bridge | 24 |
| browser | 10 |
| desktop | 32 |
| service | 8 |
| web-api | 161 |

## 定位

Uni-CLI 位于 Agent 应用之下、网站/桌面应用/本地工具/系统能力之上。它不是 scraper，不是协议壳，也不是 CUA-first 产品。稳定原语是一条 Agent 能搜索、检查、执行、记录、修复的命令。

常用路径很短：用 `unicli search` 找命令，用 `unicli describe` 看参数，用 `unicli <site> <command>` 执行，需要证据时加 `--record`。失败时，错误信封会告诉你该修哪一个 adapter、哪一步 pipeline 出了问题。

## 第一条命令

```bash
npm install -g @zenalexa/unicli
unicli search "hacker news frontpage"
unicli hackernews top --limit 5
```

## 该从哪里开始

| 你要做什么     | 从这里开始                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| 安装并跑起来   | [快速开始](/zh/guide/getting-started)                                                                    |
| 看支持哪些站点 | [站点目录](/zh/reference/sites)                                                                          |
| 接入智能体     | [集成方式](/zh/guide/integrations)                                                                       |
| 新增或修复工具 | [适配器](/zh/guide/adapters) 和 [自修复](/zh/guide/self-repair)                                          |
| 查精确行为     | [适配器格式](/zh/ADAPTER-FORMAT)、[管线步骤](/zh/reference/pipeline)、[退出码](/zh/reference/exit-codes) |
| 理解整体设计   | [架构](/zh/ARCHITECTURE)、[基准](/zh/BENCHMARK)、[路线图](/zh/ROADMAP)                                   |

## 给智能体的索引

站点也发布了 agent-readable 索引：[`/llms.txt`](/llms.txt)。它告诉智能体安装方式、命令目录、adapter 格式和修复循环，不需要先爬完整站。
