<!-- 由 docs/zh/ARCHITECTURE.md 生成。不要直接编辑此副本。 -->

# 架构

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/ARCHITECTURE
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/ARCHITECTURE.md
- 栏目: 项目

Uni-CLI 是操作真实软件的本地命令运行时。核心抽象是操作，包含名称、参数、目标、操作效果、执行接口和结果契约。

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

CLI、MCP、ACP、生成的 Agent 资源和文档目录都可以发现同一条操作。

## Catalog

目录合并四类来源。

1. 包内 YAML 与 TypeScript 适配器
2. 固定核心命令
3. `~/.unicli/adapters/` 下的用户适配器
4. 插件与本机发现的外部 CLI

`unicli search` 先编译任务，再对目录排序。`unicli describe` 返回选中操作的契约。本地开发时，用户适配器可以覆盖包内同名命令。

## 意图编译与排序

命令发现会在读取倒排列表前编译一次请求。查询计划将剩余任务文本与实体、数量、站点、操作类别、执行接口、浏览器禁用条件及其他硬约束一起保存。

站点 ID 和已维护的别名通过哈希索引解析。多词名称使用有边界的短语匹配。预计算的对称删除索引提出拼写候选，再通过有界 Damerau-Levenshtein 距离确认唯一最近的提供方。拼写存在歧义时，查询保留开放的站点范围。

双语倒排索引结合 BM25 与 TF-IDF，再用实体、工作流、操作类别和可执行性信号调整词法候选。硬能力要求会在有界 top-k 选择前移除不兼容命令。每条结果都带有 `ranking.lexical_score`、`ranking.semantic_score`、`ranking.prior` 和具名 `ranking.signals`，Agent 可以据此检查排序依据。

本机发现的 macOS 命令复用当前清单快照生成的索引。清单刷新、配置变化和显式失效会同步更新注册表、受影响的已编译命令和派生索引。运行时搜索与 manifest 搜索都优先使用用户编写的同名命令。常驻 CLI 和 MCP 共用清单管理逻辑。

## 证据检索与正文读取

`retrieval search` 选择已注册的只读来源，通过控制内核执行有并发上限的查询。来源元数据决定参数如何传入、结果如何分类。每条结果保留来源记录、规范 URL、时间戳和下一步读取命令。来源失败时，结果包含准确的重试命令。

倒数排名融合按独立来源和规范结果计分。同一来源的重复记录只贡献一次最佳排名。系统先按相关性或时间排序，再截取前 k 项；排序键相同时保留首次出现的顺序。部分来源失败时，可用结果与失败信息一起返回。全部来源失败时，保留各来源的原因和重试路径；来源成功且没有匹配项时，返回 `empty_result`。

正文读取器跟随重定向，保留原始 URL 和最终 URL。HTML 清理为 Markdown 与纯文本选择同一个语义内容区域。Turndown 负责 Markdown 转换，`html-to-text` 负责纯文本转换，保留字面标点和代码。证据结果统一处理截断和链接解析。

## Operation contract

操作契约记录以下字段。

- 站点、命令、描述和参数 Schema
- 目标范围和兼容平台
- 执行接口和最低能力要求
- 操作类别、操作效果和幂等性
- 认证与交互要求
- 适配器源文件和修复元数据

命令发现、dry-run、执行、权限检查和协议接口共享这些字段。

## Control kernel

控制内核先验证输入并应用策略，再让执行接口连接目标。它负责以下工作。

- 参数 Schema 和输入渠道
- 权限配置和批准
- 浏览器会话和目标归属
- 执行记录和效果元数据
- 错误映射和进程状态

内核将执行计划交给选中的执行接口。

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

适配器类型、连接策略和执行接口分别描述一次调用的不同层面。

## Adapter engine

YAML 适配器用流水线描述请求、转换、浏览器交互、文件下载和控制流程。传输原生动作向视觉和无障碍驱动提供平台能力。

TypeScript 适配器适合 SDK、流式服务和自定义状态流程，并使用相同的元数据与响应契约。

## Browser runtime

Browser Runtime Broker 管理浏览器提供方、配置分区、Agent 会话、目标和租约。浏览器命令可以选择隐藏的托管浏览器、后台 Chrome、前台 Chrome 或已配置的远程浏览器。

状态读取返回与快照及目标绑定的 ref，后续动作在同一会话中解析这些引用。

## Desktop 与 visual runtime

`compute` 将动作分配给 macOS、Windows、Linux、Electron 或已连接视觉驱动上的可用实现。快照会说明选中的驱动，并返回后续操作所需的 ref。健康检查反映当前主机支持的配置方式。

Cua Driver 负责原生坐标转换和截图映射。Uni-CLI 传递截图像素坐标、截图标识及 observation 记录中的驱动会话，空闲会话由驱动清理。`unicli doctor compute --providers --install` 通过官方安装器安装缺失的驱动，再检查已安装驱动的接口契约。配置方法和 observation 有效期见[原生坐标驱动](/zh/guide/browser-desktop#原生坐标驱动)。

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

失败调用将稳定的错误码、消息、恢复建议和可用修复数据放入 `error`。进程退出码表示对应失败类别。

## Repair

适配器错误可以提供 `adapter_path` 和 `step`。Agent 更新对应源文件后，运行 `unicli repair` 重新调用原操作完成验证。用户适配器用于保存仍在本机验证的修复。

## Harness evolution kernel

演进内核根据选定的执行轨迹更新适配器，负责以下流程。

1. `runs distill` 生成私有证据包，排除重放参数和私密事件字段。本地轨迹内容标记为不可信数据，原始轨迹通过本地引用保留。
2. `evolve adapter` 将基线和候选实现放入独立的用户适配器覆盖目录。候选实现发生变化时，必须声明假设、预期修复项及可选的风险用例。操作身份、输入输出契约、流水线动作、请求方法和请求头，以及已有子进程调用保持固定。新增网络来源时，创建会话的命令需要传入 `--allow-origin`。
3. 提案记录、验证记录和保留测试记录保持互斥。评估文件可以用 `train`、`validation` 或 `held-out` 标记用例。
4. 基线与候选实现的用例通过公开 CLI 交替执行。每次尝试保存带内容哈希的候选实现、补丁和报告。后续候选实现成功后，原有拒绝记录仍可读取。
5. `evolve adapter --candidate ... --promote` 仅在验证严格提升、保留测试没有退化时安装候选实现。晋级前先准备完整回滚文件。晋级和回滚都可以在写入中断后继续。

上层 Agent 负责提出和编辑候选实现，Uni-CLI 负责执行验证及晋级决策。候选哈希未变化时，晋级复用最新合格记录，省去重复评估。尝试记录提交、晋级和回滚在多个 Agent 进程之间串行执行。会话格式 v2 校验不可变产物，并迁移开发阶段 v1 格式保存的尝试历史。`evolve inspect` 保留无效会话供检查。1.2 版本将可编辑组件限定为每个会话一个 YAML 适配器。评估可能改变外部状态的命令需要显式允许。

## 协议入口

原生 CLI 提供完整运行时。MCP 提供 compact、deferred 和 expanded 工具配置。ACP 与其他生成接口从同一目录映射操作。`unicli mcp health` 报告当前安装版本使用的配置和工具数量。

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
