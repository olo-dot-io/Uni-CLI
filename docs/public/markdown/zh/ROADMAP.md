<!-- 由 docs/zh/ROADMAP.md 生成。不要直接编辑此副本。 -->

# 路线图

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/ROADMAP
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/ROADMAP.md
- 栏目: 解释
- 上级: 解释 (/zh/ARCHITECTURE)

> Current: v0.400.1 — Apollo · Young. 静态 adapter 目录：<!-- STATS:site_count -->324<!-- /STATS --> 个站点、<!-- STATS:command_count -->1817<!-- /STATS --> 条已注册命令；运行时另加入固定 core 与主机动态发现命令。<!-- STATS:pipeline_step_count -->105<!-- /STATS --> 个 built-in action（<!-- STATS:pipeline_registered_step_count -->50<!-- /STATS --> 个 registered + <!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --> 个 transport-native）。

路线图按“Agent 控制真实软件的控制平台”成熟度推进，不按固定周节奏发布。发布节奏取决于社区反馈和实际开发状态。

## 已发布

| 方向                   | 状态                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Operation catalog      | Web、browser、desktop、macOS、bridge、本地工具、protocol 操作都能通过 `list/search/do` 发现。         |
| v2 envelope            | 常规命令返回结构化成功/失败信封。                                                                     |
| Operation policy       | `open`、`confirm`、`locked` 已暴露 effect/risk/capability/resource scope，并支持私有审批记忆。        |
| Run recording          | `--record` / `UNICLI_RECORD_RUN=1` 会写入可 list/show/probe/replay/compare 的 run trace。             |
| Browser evidence       | 浏览器动作可以记录前后证据、移动维度、stale-ref 细节和 watchdog 结果。                                |
| Local computer control | `compute` 已暴露 App 发现、snapshot、ref、click、type、key、scroll、launch、screenshot 和 assertion。 |
| Runtime exposure       | native CLI、JSON stream、MCP、ACP、HTTP API、OpenAI-compatible、bridge 已建模。                       |
| Self-repair / delivery | 错误包含 adapter path、step、retryability、suggestion、alternative；delivery 命令可评估目标和轨迹。   |

## 当前重点

- 保持公开文档、architecture tree、命令描述和 Agent 入口都围绕 Agent-to-computer control over real software，而不是回退到 catalog/lifecycle-first。
- 把浏览器自动化、computer-use sandbox、MCP、自然语言本地执行、单站点 wrapper 明确放到 substrate 层。
- 用 `architecture audit` 的 `capability_matrix` 和 `workflow_readiness` 区分 catalog 覆盖和仍需 live evidence 的行为能力。
- 让 adapter 命令和 core Commander 命令投影成同一份 operation contract。
- 继续强化 run/event kernel，保持执行证据 append-only、本地化、可审查，并能比较 replay 和原始 trace。
- 扩大 operation policy 的 effect/risk/capability/resource scope 覆盖；需要反复批准时用
  `--yes --remember-approval`，不把原始参数写入记忆。
- 提升桌面应用控制能力，尤其是微信、企业微信、钉钉、飞书、Mail、Notes、Office 和常见 Electron 应用。
- 让 Office、浏览器、外部 CLI 和本地工具的控制体验更稳定。
- 打磨 agent-readable 文档和 Markdown companion。
- 强化自修复、schema lint 和 adapter health gate。
- 把外部 agent-loop、computer-use、编辑器 agent、桌面自动化的新认知沉淀为内部来源图谱、公开能力路线图和本地实现计划，而不是只留在提示词里。

## 近期方向

| 方向                      | 目标                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Computer-control model    | `architecture tree/audit`、README、docs、Agent 入口都保持同一套上位模型。                            |
| Operation-contract parity | 生成型 TypeScript 命令、core 命令、`describe`、`--dry-run`、MCP、ACP 参数一致。                      |
| Control kernel            | 扩大证据覆盖，但保持默认不记录隐私状态。                                                             |
| Operation policy          | 默认 open；继续补 effect/risk/capability/resource scope，并支持 scope 级审批记忆。                   |
| Substrate bus             | HTTP、CDP、a11y、subprocess、service、Visual 共享调用内核和证据模型。                                |
| Desktop control           | 按 API/CDP/a11y/后台动作/Visual 的层级控制桌面应用。                                                 |
| Visual truthfulness       | 没有可见、可行动、可验证后端时不把 Visual 标成 live。                                                |
| Delivery-loop alignment   | 支持并行/后台 agent、隔离 worktree、reviewable evidence。                                            |
| Adapter quality           | 更少“假成功”，更多结构化错误和可修复建议。                                                           |
| Browser-backed adapters   | 更稳的 CDP、快照、拦截、selector 修复和动作后验证。                                                  |
| Workflow evidence         | 媒体、视频搜索、浏览器 tab、已安装 App、生产力状态、打开/导航目的地都要从 cataloged 走向有证据声明。 |
| Docs i18n                 | 先维护英文和简体中文，保持术语一致。                                                                 |
| Agent ergonomics          | 让智能体更快发现操作、更少消耗上下文。                                                               |

## 近期交付顺序

1. 锁住 computer-control root model：architecture tree/audit、README、How-it-works、FAQ、Roadmap 不能回退成工具目录叙事。
2. 补齐 operation-contract parity：adapter 命令和 core Commander 命令共享合同投影。
3. 强化 control kernel：结果 envelope、权限评估、browser action evidence 都要可审查。
4. 扩大 operation policy 覆盖：默认开放，`confirm` / `locked` 可选，`describe` 和 `--dry-run` 持续暴露风险。
5. 为微信、企业微信、钉钉、飞书、Mail、Notes、Word、PPT、Excel 建立桌面控制 fixture。
6. 为不完整 AX 壳的 Electron 应用加入 CDP、a11y、后台动作、Visual 的分层 fallback。
7. 把外部趋势搜索变成定期输入：来源归档在内部，公开文档只保留能力结论，然后回到本地测试验证。
8. 从 `workflow_readiness` 里挑 cataloged 但缺少 live evidence 的工作流，逐个补 runner、fixture、live smoke 或 platform doctor；不要为了覆盖数字新增未验证命令。

## 非目标

- 不为了展示而引入厚 SDK。
- 不让协议层绑架核心 CLI 合同。
- 不把没有真实动作桥的 Visual 当成可用能力。
- 不让外部趋势替代当前工作树、测试和 git 历史。
- 不默认替用户收紧全部命令；默认开放，收紧交给 profile。
- 不把 Uni-CLI 定位成浏览器库、MCP wrapper、computer-use sandbox、自然语言 shell、scraper 或单站点 wrapper 集合。

## 判断标准

能力是否进入发布，主要看：

- 是否增强 Agent 控制 computer 的真实工作流。
- 是否有测试或健康检查覆盖。
- 失败时是否可诊断。
- 文档是否能让智能体和人都读懂。

## 验证

公开定位和文档变更至少运行：

```bash
npm run docs:build
npm run docs:check-public
```
