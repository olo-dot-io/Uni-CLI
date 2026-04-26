<!-- 由 docs/zh/index.md 生成。不要直接编辑此副本。 -->

# 概览

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/index.md
- 栏目: 开始

## AI 智能体与真实软件之间的通用接口。

用一条原生 CLI 串起真实操作：按意图发现命令，执行 typed adapter，返回结构化 AgentEnvelope，并在自动化失效时就地修复。

## 主要入口

- [快速开始](/zh/guide/getting-started)
- [浏览站点](/zh/reference/sites)

## 核心能力

- **按意图搜索.** 双语 BM25 把自然语言映射到 223 个站点、1304 条可运行命令。
- **操作真实软件.** 同一套 CLI 覆盖 Web API、浏览器自动化、macOS 应用、桌面工具和外部 CLI。
- **返回 AgentEnvelope.** Markdown、JSON、YAML、CSV 和 compact 输出共用同一套 v2 成功/错误合同。
- **就地修复.** 失败结果会带上 adapter path、pipeline step、是否可重试、建议和替代命令。
- **接入智能体.** 命令行执行对 coding agent 是原生路径；MCP、ACP 和 JSON stream 是兼容接口。
- **保持轻量.** YAML adapter 组合 typed pipeline steps，不为每个站点引入沉重 SDK。

## 目录快照

- 站点：223
- 命令：1304
- 接口类型：5
- AgentEnvelope：v2

| 接口类型 | 站点数 |
| --- | ---: |
| bridge | 24 |
| browser | 10 |
| desktop | 32 |
| service | 8 |
| web-api | 149 |

## 定位

Uni-CLI 面向已经能使用 shell 的智能体。它不是把所有软件包装成一个厚协议层，而是把可搜索、可执行、可修复的操作收敛成命令。

常用路径很短：用 `unicli search` 找命令，用 `unicli describe` 看参数，用 `unicli <site> <command>` 执行。失败时，错误信封会告诉你该修哪一个 adapter、哪一步 pipeline 出了问题。

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
