---
title: 架构
description: Uni-CLI 如何把 Agent 意图转换为经过验证的操作与结构化结果。
---

# 架构

Uni-CLI 是操作真实软件的本地命令运行时。核心抽象是 operation，它包含名称、参数、目标、effect、execution operator 和结果合同。

## 运行流程

```text
意图
  → 编译意图计划
  → 筛选可行候选
  → 返回带依据的排序结果
  → operation contract
  → 参数与权限检查
  → execution operator
  → AgentEnvelope
  → repair 或下一步
```

CLI、MCP、ACP、生成的 Agent asset 和文档目录都可以发现同一条 operation。

## Catalog

目录合并四类来源。

1. packaged YAML 与 TypeScript adapter
2. fixed core command
3. `~/.unicli/adapters/` 下的 user adapter
4. plugin 与主机发现的外部 CLI

`unicli search` 先编译任务，再对目录排序。`unicli describe` 返回选中操作的合同。本地开发时，user adapter 可以覆盖同名 packaged entry。

## 意图编译与排序

Discovery 在读取 posting list 前只编译一次请求。计划把剩余任务文本与 entity、cardinality、site、operation family、operator、浏览器禁用条件及其他硬约束放在一起。

Site id 和维护过的 alias 通过哈希索引解析。多词名称使用有边界的短语匹配。预计算的 symmetric-delete 索引先提出拼写候选，随后由有界 Damerau-Levenshtein 距离确认唯一最近的 provider。存在歧义时，不添加 site 约束。

双语倒排索引结合 BM25 与 TF-IDF。Entity、workflow、operation family 和 feasibility 信号会调整词法候选。硬能力要求在有界 top-k 选择前移除不兼容命令。每条结果都带有 `ranking.lexical_score`、`ranking.semantic_score`、`ranking.prior` 和具名 `ranking.signals`，Agent 可以据此检查排序来源。

## Operation contract

一条 operation contract 记录以下字段。

- site、command、description 与 argument schema
- target surface 与兼容平台
- execution operator 与 minimum capability
- operation family、effect 与 idempotency
- authentication 与 interaction 要求
- adapter source 与 repair metadata

Discovery、dry-run、执行、权限检查和协议 projection 共享这些字段。

## Control kernel

Control kernel 先验证输入并协调 policy，再让 operator 取得目标。它负责以下工作。

- argument schema 与输入 channel
- permission profile 与 approval
- browser session 和 target ownership
- run record 与 effect metadata
- error mapping 与进程状态

Kernel 把一份 execution plan 交给选中的 operator。

## Execution operator

| Operator                | 常见边界                                      |
| ----------------------- | --------------------------------------------- |
| `structured-api`        | HTTP API 或结构化页面 endpoint                |
| `browser-protocol`      | CDP 或 browser network protocol               |
| `native-cli`            | 已安装的外部命令                              |
| `browser-semantic`      | 浏览器 DOM 与 accessibility action            |
| `desktop-accessibility` | 操作系统 accessibility tree 与 native control |
| `visual-observation`    | 截图或 pixel observation                      |
| `visual-coordinate`     | 基于坐标的桌面 action                         |
| `local-runtime`         | 文件、本地函数与 core service                 |

Adapter type、strategy 和 operator 描述一次调用的不同层面。

## Adapter engine

YAML adapter 用 pipeline 描述 fetch、transform、browser interaction、file download 和 control flow。Transport-native action 为 visual 与 accessibility provider 加入平台能力。

TypeScript adapter 面向 SDK、streaming service 与自定义 state machine，同时使用相同 metadata 和 envelope contract。

## Browser runtime

Browser Runtime Broker 管理 provider、profile partition、Agent session、target 和 lease。Browser command 可以选择 hidden managed browser、background Chrome、foreground Chrome 或 configured remote provider。

State read 返回与 snapshot 和 target 绑定的 ref，后续 action 在同一 session 中解析 ref。

## Desktop 与 visual runtime

`compute` 把 action 路由到 macOS、Windows、Linux、Electron 或已连接 visual driver 上可用的 provider。Snapshot 会说明选中的 provider，并返回后续操作所需的 ref。Health command 反映当前主机支持的设置。

## Result envelope

常规命令都返回 v2 AgentEnvelope。

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "site.command",
  "meta": {},
  "data": {},
  "error": null
}
```

失败调用把稳定 code、message、suggestion 和可用 repair 数据放到 `error`。进程退出码表示对应失败类别。

## Repair

Adapter failure 可以暴露 `adapter_path` 和 `step`。Agent 更新对应源文件后运行 `unicli repair`，它会调用原目标完成验证。User adapter 提供本机测试路径。

## Harness evolution kernel

Evolution kernel 把选定的 run trace 转换为受控的 adapter 更新。它负责五个边界。

1. `runs distill` 生成私有 evidence packet，不写入 replay 参数和 secret event field。Provenance 会把本地 trace content 标记为 untrusted，raw trace 只保留本地 reference。
2. `evolve adapter` 把 baseline 与 candidate 放入独立的 user-adapter overlay。发生变化的 candidate 必须声明 hypothesis、预期修复项和可选的风险 case。Scope 会固定 identity、输入输出 contract、pipeline action、request method 与 header，以及已有 subprocess invocation。新增 network origin 时，创建 session 的命令需要传入 `--allow-origin`。
3. Proposal run、validation run 和 held-out run 保持互斥。Eval file 可以用 `train`、`validation` 或 `held-out` 标记 case。
4. Baseline 与 candidate case 通过公开 CLI 交替执行。每个 attempt 都会保存带 content hash 的 candidate、patch 和 report。后续 candidate 成功后，rejected attempt 仍然可读。
5. `evolve adapter --candidate ... --promote` 只会在 validation 严格提升且 held-out 没有回退时安装 candidate。Promotion 会先准备精确 rollback artifact，再安装 candidate。Promotion 与 rollback 都可以在写入中断后继续。

上层 Agent 负责提出并编辑 candidate。Uni-CLI 负责执行证据和 promotion decision。Candidate hash 未变化时，promotion 会复用最新 eligible attempt，不会因为 review 再次运行 eval。Attempt commit、promotion 和 rollback 会在多个 Agent process 之间串行执行。Session format v2 会校验 immutable artifact，并迁移开发阶段 v1 format 写入的 attempt history。`evolve inspect` 会保留 invalid session。1.2 版本把 editable evolution component 限定为单个 YAML adapter。可能改变外部状态的命令需要显式允许 eval。

## 协议入口

Native CLI 暴露完整 runtime。MCP 提供 compact、deferred 和 expanded tool profile。ACP 与其他生成 surface 从同一目录投影操作。`unicli mcp health` 会报告当前安装版本的 profile 和工具数量。

## 源码位置

| 区域                      | 源码                               |
| ------------------------- | ---------------------------------- |
| Catalog 与 registry       | `src/registry.ts`、`src/adapters/` |
| 意图编译                  | `src/discovery/intent-plan.ts`     |
| 目录排序                  | `src/discovery/search.ts`          |
| 排序语义                  | `src/discovery/intent-ranking.ts`  |
| Site identity 解析        | `src/discovery/site-resolver.ts`   |
| 能力可行性                | `src/discovery/feasibility.ts`     |
| Engine 与 pipeline        | `src/engine/`                      |
| Harness evolution         | `src/engine/evolution/`            |
| Command surface           | `src/commands/`                    |
| Browser runtime           | `src/browser/`                     |
| Desktop 与 visual control | `src/compute/`、`src/transport/`   |
| Shared contract           | `src/types.ts`、`src/core/`        |
| Protocol server           | `src/mcp/`、`src/commands/acp.ts`  |

## 相关文档

- [工作原理](/zh/how-it-works)
- [适配器格式](/zh/ADAPTER-FORMAT)
- [Pipeline steps](/zh/reference/pipeline)
- [退出码](/zh/reference/exit-codes)
