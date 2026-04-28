---
layout: home

hero:
  name: "Uni-CLI"
  text: "面向真实软件的 Agent 执行底座。"
  tagline: "按意图发现命令，跨 Web、应用、本地工具和系统能力执行可治理操作，再返回带证据的 AgentEnvelope，方便智能体检查和修复。"
  image:
    src: /mascot-otter.png
    alt: Uni-CLI mascot holding a terminal tablet
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 浏览站点
      link: /zh/reference/sites

features:
  - title: 按意图发现
    details: "双语 BM25 把自然语言映射到 235 个站点、1448 条可运行命令。"
  - title: 执行真实表面
    details: "同一套 CLI 覆盖 Web API、浏览器自动化、macOS 应用、桌面工具、本地服务和外部 CLI。"
  - title: 返回 AgentEnvelope
    details: "Markdown、JSON、YAML、CSV 和 compact 输出共用同一套 v2 成功/错误合同。"
  - title: 治理副作用
    details: "Operation policy 通过 open、confirm、locked profile 暴露 effect、risk、approval 和 capability scope。"
  - title: 记录证据
    details: "可选 run trace 和浏览器动作证据让执行过程可审查，同时不改变命令合同。"
  - title: 就地修复
    details: "失败结果会带上 adapter path、pipeline step、是否可重试、建议和替代命令。"
  - title: 接入智能体
    details: "命令行执行对 coding agent 是原生路径；MCP、ACP 和 JSON stream 是兼容接口。"
---

<VersionNotice />

<SiteStats />

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
