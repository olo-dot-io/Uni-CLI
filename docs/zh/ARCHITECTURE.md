# 架构

Uni-CLI 是 AI Agent 控制 computer 的通用平台。它的核心不是浏览器自动化、MCP、computer-use sandbox、自然语言 shell 或单站点 wrapper，而是一条可发现、可治理、可观察、可修复、可交付的 Agent-to-computer 控制闭环。

## 分层

```text
Agent / human
  ↓
intent
  ↓
search / do / describe
  ↓
operation contract
  ↓
policy + control kernel
  ↓
substrates: HTTP, browser/CDP, desktop/a11y, subprocess, protocol, Visual
  ↓
websites, desktop apps, local tools, files, system capabilities, external CLIs
  ↓
evidence / delivery / repair
```

## 关键模块

| 模块               | 职责                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| Intent / Search    | 用 BM25、alias 和 `do` 把自然语言任务映射到候选操作。                     |
| Operation contract | 描述 args、输出、认证姿态、effect、risk、capability、source/repair path。 |
| Control kernel     | 统一完成参数校验、权限判断、substrate 调用、证据记录和 envelope 返回。    |
| Action substrates  | 连接 HTTP、浏览器、桌面、本地命令、文件、协议和 Visual。                  |
| Output / Evidence  | 把结果包装成 v2 `AgentEnvelope`，并保留可审查证据。                       |
| Delivery / Repair  | 诊断失败，选择重试、换路、补认证、请求权限或进入有边界修复。              |

## 控制内核

Uni-CLI 不是 scraper、协议外壳、visual-first 产品、浏览器库或 sandbox 产品，而是智能体控制网站、桌面应用、本地工具、文件和系统能力的控制平台。内核要保持小、可审计、可验证：

- **操作合同**：manifest 是运行时合同，包含操作名、参数、能力需求、输出形状、鉴权、source path、repair path 和推断出的操作策略。
- **调用内核**：统一完成参数校验、权限判断、adapter 执行、证据记录和 `AgentEnvelope` 返回。
- **Substrate 总线**：HTTP、CDP、a11y、subprocess、service、protocol、Visual 都是同一操作合同下的行动选择。
- **权限 profile**：命令默认开放；用户可以选择 `confirm` 或 `locked` 对高影响写操作加确认。
- **交付和修复闭环**：失败必须落到一个 source path、一个 step 或边界、一个可复现验证命令。

MCP、ACP、HTTP API 和 agent 配置都是这个内核的兼容面，不应该各自定义一套行为。生成型 TypeScript 命令、YAML adapter、core Commander 命令也必须和 `search`、`describe`、`--dry-run`、直接 CLI、MCP、ACP 保持相同 operation contract；这里的漂移是正确性问题，不是文档问题。

## 产品边界与内部生命周期

产品边界是 Agent-to-computer 控制闭环，不是 adapter registry、YAML 格式、命令生命周期、MCP gateway 或某一种自动化后端。命令生命周期仍然重要，但它是内部作者和维护流程：创建、发现、调用、观察、修复、发布。公开表述必须把它放在 operation contract 和 control kernel 之下，避免重新退回到 catalog-first 或 wrapper-first 叙事。

## 能力矩阵与工作流就绪度

`unicli architecture audit -f json` 会从 live registry 产出两张表，让“车载助手”类比落到可检查数据，而不是变成愿景口号。

`capability_matrix` 按真实控制 surface 分类：

- `web`：HTTP、RSS、public/cookie/header Web 路径，以及 Web target surface。
- `browser`：CDP、browser ref、browser evidence 和浏览器后端 adapter。
- `desktop`：installed app、无障碍、本地 UI 和 desktop target surface。
- `system`：OS 状态、macOS 命令、本地服务和 system target surface。
- `protocol`：MCP、ACP、delivery/runs/architecture 控制服务，以及 service/protocol 边界。
- `bridge`：透传到成熟外部 CLI，例如 `gh`、`yt-dlp` 或 cloud CLI。

每行包含 command count、adapter/core 拆分、写敏感命令数、本地 computer-use 命令数、source-path 覆盖和代表命令。同一命令可以进入多行，例如 browser-backed Web adapter，或同时控制 desktop 和 system 状态的 macOS 命令。

`workflow_readiness` 对齐真实用户工作流：

- 播放或检查媒体；
- 搜索视频平台；
- 操作浏览器 tab；
- 操作已安装 App；
- 读写生产力状态；
- 打开或导航到目的地。

就绪度刻意保守：

- `cataloged` 表示 live catalog 已有 operation contract；需要行动的工作流还必须有 action-capable command。
- `partial` 表示已有相关读取/发现路径，但还不足以声明完整行动能力。
- `gap` 表示 live catalog 没有匹配操作路径。

任何 workflow row 都不宣称 live 成功。每行带 `required_next_evidence`，下一步能力建设必须跑命令、捕获 envelope、验证执行后状态、记录 auth/policy 姿态，之后才能把 catalog 覆盖升级成行为声明。

## 为什么 CLI-first

智能体已经能运行 shell。CLI-first 的好处是：

- 不需要为每个客户端复制一套协议适配。
- 容易组合：pipe、redirect、jq、shell scripts 都能用。
- 错误能用退出码快速路由。
- 输出可以同时服务人和机器。
- 本地覆盖和修复不依赖远端服务。

MCP、ACP 等协议接口仍然提供，但它们是 exposure/protocol substrate，不是核心语义模型。

## 桌面和 Visual 分层

Adapter 应声明最小需要的能力。桌面应用尤其是中国常见 Electron 应用经常只有不完整的 AX 壳，控制路径要按层级升级：

1. 稳定 API、本地 CLI 或文件格式。
2. CDP 或应用调试协议。
3. a11y 树的文本、角色、层级匹配。
4. 能确认目标时使用后台 click/type/press 原语。
5. Visual 截图规划、执行和执行后验证。

Visual 只有在后端真的能看见、行动、验证时才算 live。没有动作桥时，应返回明确的 unavailable/setup 错误，而不是假装成功。

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
- `approval_memory`：稳定的命令 scope key，包含 capability 维度和资源
  metadata。`--remember-approval` 会把允许的 scope 存到
  `~/.unicli/approvals.jsonl`，文件只含 scope metadata。`unicli approvals list`、
  `revoke`、`clear` 用来查看或移除已记住的 scope。
- `deny_rule`：本地 JSON/YAML 策略命中时返回规则 id 和原因。schema v1 保留
  deny-only/default-allow；schema v2 支持 deny 优先的 `allow`/`deny`、显式
  `default`，以及 `min`、`max`、`max_length`、RE2 `pattern`、`allowed` 参数
  约束。规则还可以按站点、命令、effect、capability 维度和资源 scope 匹配，
  优先级高于 `--yes` 和已记住的审批。调用内核、直接 browser/operate、直接
  compute 与 computer-use MCP 使用同一授权边界。同一层规则还会守住 pipeline
  运行时域名、浏览器跳转目标、下载和输出路径、子进程可执行文件，在操作碰到资源
  之前停下。显式策略文件缺失或格式错误时，执行以 `invalid_input` fail closed。

这样默认仍然足够开放，团队或个人需要收紧时也不用改 adapter metadata。

## 运行和证据模型

Run recording 是显式启用的本地能力。`--record` 或
`UNICLI_RECORD_RUN=1` 会把 append-only JSONL trace 写到
`~/.unicli/runs`，内容包括命令 metadata、权限评估、私有 replay payload、
结果 envelope 证据、warning 和耗时。记录需要显式开启，因为很多操作会包含私有账号状态。

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

Uni-CLI 位于 agent 应用之下、真实网站/桌面应用/本地工具/文件/系统能力之上。它不是 IDE、不是聊天产品、不是模型托管层、不是浏览器库、不是 MCP wrapper、不是 computer-use sandbox、不是自然语言 shell、不是 scraper、不是协议壳，也不是单一 agent loop；它是这些产品都应该能调用的 computer-control 平台。

采用：

- 原生 CLI 和 shell 作为第一 agent 接口。
- Operation contract 承载可持久修复的网站、应用、本地工具、文件和协议操作。
- YAML adapter 作为低成本作者格式，而不是产品身份。
- API、CDP、a11y、subprocess、应用协议优先。
- 只有能看见、能行动、能验证时才使用 Visual。
- 操作需要审查时记录可 probe/replay/compare 的 run trace、带 tab/auth 姿态的
  browser session lease、render-aware evidence 和 watchdog 移动检查。
- MCP、ACP、HTTP 作为由同一 operation contract 生成的兼容面。

不采用：

- 把 ACP 或 MCP 当作核心语义模型。
- 把浏览器自动化、sandbox 或 visual fallback 当作产品边界。
- API/CDP/a11y/subprocess 可用时不先用 Visual。
- 把静态隐私标签当作唯一安全机制。
- 把没有观察证据的浏览器动作当作成功副作用。
- 引入隐藏 adapter 路径、失败 step、修复证据的厚 SDK。

## Adapter registry

Adapter 是常见的作者和运行时单元，不是产品的最小概念。产品最小概念是 operation contract。registry 会加载：

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
