# 架构

Uni-CLI 是面向真实软件的 Agent 执行底座。它的核心不是协议，而是一个可发现、可检查、可执行、可记录、可修复的命令层。

## 分层

```text
Agent / human
  ↓
unicli CLI
  ↓
Search + dispatch
  ↓
Adapter registry
  ↓
Pipeline engine
  ↓
Transports: HTTP, browser/CDP, desktop, subprocess, service, CUA
  ↓
Websites, desktop apps, local tools, system capabilities, external CLIs
```

## 关键模块

| 模块       | 职责                                                    |
| ---------- | ------------------------------------------------------- |
| CLI        | 解析命令、选择输出格式、返回退出码。                    |
| Search     | 用 BM25 和别名把自然语言意图映射到命令。                |
| Registry   | 加载 YAML/TypeScript adapter，生成 manifest。           |
| Engine     | 执行 pipeline steps，处理变量、策略、证据、错误和输出。 |
| Transports | 连接 HTTP、浏览器、桌面、本地命令和服务。               |
| Output     | 把结果包装成 v2 `AgentEnvelope`。                       |
| Repair     | 让失败结果指向可修复的 adapter 和 step。                |

## 控制内核

Uni-CLI 不是 scraper、协议外壳或 CUA-first 产品，而是智能体控制网站、桌面应用、本地工具、文件和系统能力的控制内核。内核要保持小、可审计、可验证：

- **命令注册表**：manifest 是运行时合同，包含命令名、参数、能力需求、输出形状、鉴权和推断出的操作策略。
- **调用内核**：统一完成参数校验、权限判断、adapter 执行、证据记录和 `AgentEnvelope` 返回。
- **传输总线**：HTTP、CDP、a11y、subprocess、service、CUA 都是同一命令合同下的传输选择。
- **权限 profile**：命令默认开放；用户可以选择 `confirm` 或 `locked` 对高影响写操作加确认。
- **修复和评测闭环**：失败必须落到一个 adapter、一个 step、一个可复现验证命令。

MCP、ACP、HTTP API 和 agent 配置都是这个内核的兼容面，不应该各自定义一套行为。生成型 TypeScript 命令也必须和 `search`、`describe`、`--dry-run`、直接 CLI、MCP、ACP 保持相同参数 schema；这里的漂移是正确性问题，不是文档问题。

## 为什么 CLI-first

智能体已经能运行 shell。CLI-first 的好处是：

- 不需要为每个客户端复制一套协议适配。
- 容易组合：pipe、redirect、jq、shell scripts 都能用。
- 错误能用退出码快速路由。
- 输出可以同时服务人和机器。
- 本地覆盖和修复不依赖远端服务。

MCP、ACP 等协议接口仍然提供，但它们是兼容层，不是核心运行时。

## 桌面和 CUA 分层

Adapter 应声明最小需要的能力。桌面应用尤其是中国常见 Electron 应用经常只有不完整的 AX 壳，控制路径要按层级升级：

1. 稳定 API、本地 CLI 或文件格式。
2. CDP 或应用调试协议。
3. a11y 树的文本、角色、层级匹配。
4. 能确认目标时使用后台 click/type/press 原语。
5. CUA 截图规划、执行和执行后验证。

CUA 只有在后端真的能看见、行动、验证时才算 live。没有动作桥时，应返回明确的 unavailable/setup 错误，而不是假装成功。

## 操作策略

读操作可以覆盖很广；写操作必须更严格，因为它们会发送邮件、给人发消息、修改文档或操作账号。

默认姿态是 **open**。Uni-CLI 不应该把所有 adapter 默认改成 private，也不应该因为一个命令可能写入就默认阻断。操作策略是用户可选的运行时层：

| Profile   | 行为                                                         |
| --------- | ------------------------------------------------------------ |
| `open`    | 默认。直接运行，同时暴露推断出的风险。                       |
| `confirm` | 对发送、发帖、服务状态、破坏性写入等高影响操作要求显式批准。 |
| `locked`  | 对中高影响写操作都要求显式批准。                             |

调用内核会从命令合同推断并在 `describe`、`--dry-run`、执行期暴露：

- `effect`：`read`、`send_message`、`publish_content`、`account_state`、`remote_transform`、`remote_resource`、`service_state`、`local_app`、`local_file`、`destructive`。
- `risk`：`low`、`medium`、`high`。
- `approval_required`：当前 profile 下是否需要 `--yes` 或 `UNICLI_APPROVE=1`。

这样默认仍然足够开放，团队或个人需要收紧时也不用改 adapter metadata。

## 运行和证据模型

Run recording 是显式启用的本地能力。`--record` 或
`UNICLI_RECORD_RUN=1` 会把 append-only JSONL trace 写到
`~/.unicli/runs`，内容包括命令 metadata、权限评估、结果 envelope
证据、warning 和耗时。它不默认开启，因为很多操作会包含私有账号状态。

浏览器 operator 命令还能记录更细的动作证据。被记录的动作会保存前后证据包、页面移动维度、stale-ref 失败细节和可选 watchdog 结果。证据的目的是真实说明自动化观察到了什么，而不是替代 adapter 合同。

## 持续认知输入

外部趋势不能替代代码、测试和 git 证据，但可以更新方向判断。2026-04-28 的公开定位校准显示，类似系统越来越强调可控 workflow、observability、policy、人类 review 和互操作性，而不是单纯强调 autonomy。

这些趋势对 Uni-CLI 的启发是：

- agent loop 正在向原生工具执行靠近，而不是只围绕协议包装。
- 编辑器 agent 系统正在把并行 agent、subagent、worktree、异步执行变成核心产品方向。
- browser / computer-use 自动化正在变得更语义化和可观察：状态、截图、布局证据和审计轨迹都更重要。
- computer use 工具更适合作为兜底传输，不是首选路径。
- 编辑器和桌面产品正在补持久上下文、历史记忆和异步协作。

这些趋势反而强化了本地架构：命令优先、manifest 可信、adapter 可修复、权限显式、证据可记录、传输多元。

## 行业位置

Uni-CLI 位于 agent 应用之下、真实网站/桌面应用/本地工具/系统能力之上。它不是 IDE、不是聊天产品、不是模型托管层、不是 scraper、不是协议壳，也不是单一 agent loop；它是这些产品都应该能调用的执行底座。

采用：

- 原生 CLI 和 shell 作为第一 agent 接口。
- YAML adapter 承载可持久修复的网站和应用操作。
- API、CDP、a11y、subprocess、应用协议优先。
- 只有能看见、能行动、能验证时才使用 CUA。
- 操作需要审查时记录 run trace、browser session lease、render-aware evidence
  和 watchdog 移动检查。
- MCP、ACP、HTTP 作为由同一 catalog 生成的兼容面。

不采用：

- 把 ACP 或 MCP 当作核心语义模型。
- API/CDP/a11y/subprocess 可用时不先用 CUA。
- 把静态隐私标签当作唯一安全机制。
- 把没有观察证据的浏览器动作当作成功副作用。
- 引入隐藏 adapter 路径、失败 step、修复证据的厚 SDK。

## Adapter registry

Adapter 是能力的最小单元。registry 会加载：

- 内置 `src/adapters/**`
- 本地覆盖 `~/.unicli/adapters/**`
- 插件提供的 adapter

同名本地覆盖用于快速修复，不需要等 npm 包发布。

## Pipeline engine

Engine 顺序执行 pipeline steps。每一步只做一件事：请求、选择、映射、点击、输入、运行本地命令、断言等。

这种设计让失败能定位到具体 step，也让智能体能做小范围 patch。

## AgentEnvelope

所有常规命令都返回 v2 `AgentEnvelope`：

- 成功：`ok: true`，`data` 有结果。
- 失败：`ok: false`，`error` 有 code、message、adapter_path、step、suggestion。

Markdown、JSON、YAML、CSV 和 compact 输出共享同一份底层合同。

## 设计取舍

- YAML 优先，TypeScript 作为 escape hatch。
- HTTP 优先，浏览器控制作为必要时的能力。
- 结构化错误优先，不输出无法解析的异常文本。
- 本地修复优先，不把所有修复都推迟到上游发布。

## 相关页面

- [适配器格式](/zh/ADAPTER-FORMAT)
- [管线步骤](/zh/reference/pipeline)
- [自修复](/zh/guide/self-repair)
- [集成方式](/zh/guide/integrations)
