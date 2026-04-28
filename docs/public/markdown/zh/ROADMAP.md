<!-- 由 docs/zh/ROADMAP.md 生成。不要直接编辑此副本。 -->

# 路线图

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/ROADMAP
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/ROADMAP.md
- 栏目: 解释
- 上级: 解释 (/zh/ARCHITECTURE)

> Current: v0.217.0 — Apollo · Lovell. <!-- STATS:site_count -->235<!-- /STATS --> 个站点，<!-- STATS:command_count -->1448<!-- /STATS --> 条命令，<!-- STATS:pipeline_step_count -->59<!-- /STATS --> 个 pipeline step。

路线图按能力成熟度推进，不按固定周节奏发布。发布节奏取决于社区反馈和实际开发状态。

## 已发布

| 方向             | 状态                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Adapter catalog  | Web、browser、desktop、macOS、bridge、external CLI 都能通过 `list/search` 发现。          |
| v2 envelope      | 常规命令返回结构化成功/失败信封。                                                         |
| Operation policy | `open`、`confirm`、`locked` profile 已暴露 effect、risk、approval、capability。           |
| Run recording    | `--record` / `UNICLI_RECORD_RUN=1` 会写入可 list/show/probe/replay/compare 的 run trace。 |
| Browser evidence | 浏览器动作可以记录前后证据、移动维度、stale-ref 细节和 watchdog 结果。                    |
| Agent backends   | native CLI、JSON stream、MCP、ACP、HTTP API、OpenAI-compatible、bridge 已建模。           |

## 当前重点

- 继续强化 run/event kernel，保持执行证据 append-only、本地化、可审查，并能比较 replay 和原始 trace。
- 让 manifest、运行时、fast path 和协议面共享同一份参数合同。
- 扩大 operation policy 的 effect/risk/capability-scope 覆盖，而不是默认改成 private。
- 提升桌面应用控制能力，尤其是微信、企业微信、钉钉、飞书、Mail、Notes、Office 和常见 Electron 应用。
- 让 Office、浏览器、外部 CLI 和本地工具的控制体验更稳定。
- 打磨 agent-readable 文档和 Markdown companion。
- 强化自修复、schema lint 和 adapter health gate。
- 把外部 agent-loop、computer-use、编辑器 agent、桌面自动化的新认知沉淀为内部来源图谱、公开能力路线图和本地实现计划，而不是只留在提示词里。

## 近期方向

| 方向                    | 目标                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| Run/event kernel        | 扩大证据覆盖，但保持默认不记录隐私状态。                             |
| Manifest/runtime parity | 生成型 TypeScript 命令、`describe`、`--dry-run`、MCP、ACP 参数一致。 |
| Operation policy        | 默认 open；继续补 effect/risk/capability-scope，`--yes` 显式批准。   |
| Transport bus           | HTTP、CDP、a11y、subprocess、service、CUA 共享调用内核和证据模型。   |
| Desktop control         | 按 API/CDP/a11y/后台动作/CUA 的层级控制桌面应用。                    |
| CUA truthfulness        | 没有可见、可行动、可验证后端时不把 CUA 标成 live。                   |
| Agent-loop alignment    | 支持并行/后台 agent、隔离 worktree、reviewable evidence。            |
| Industry positioning    | 作为执行底座，不做 IDE、聊天壳、模型壳、scraper 或协议壳。           |
| Adapter quality         | 更少“假成功”，更多结构化错误和可修复建议。                           |
| Browser-backed adapters | 更稳的 CDP、快照、拦截、selector 修复和动作后验证。                  |
| Docs i18n               | 先维护英文和简体中文，保持术语一致。                                 |
| Agent ergonomics        | 让智能体更快发现命令、更少消耗上下文。                               |

## 近期交付顺序

1. 强化 run/event kernel：结果 envelope、权限评估、browser action evidence 都要可审查。
2. 补齐 manifest/runtime parity 的测试和生成逻辑，避免 fast path 丢参数。
3. 扩大 operation policy 覆盖：默认开放，`confirm` / `locked` 可选，`describe` 和 `--dry-run` 持续暴露风险。
4. 为微信、企业微信、钉钉、飞书、Mail、Notes、Word、PPT、Excel 建立桌面控制 fixture。
5. 为不完整 AX 壳的 Electron 应用加入 CDP、a11y、后台动作、CUA 的分层 fallback。
6. 把外部趋势搜索变成定期输入：来源归档在内部，公开文档只保留能力结论，然后回到本地测试验证。

## 非目标

- 不为了展示而引入厚 SDK。
- 不让协议层绑架核心 CLI 合同。
- 不把没有真实动作桥的 CUA 当成可用能力。
- 不让外部趋势替代当前工作树、测试和 git 历史。
- 不默认替用户收紧全部命令；默认开放，收紧交给 profile。

## 判断标准

能力是否进入发布，主要看：

- 是否解决真实工作流。
- 是否有测试或健康检查覆盖。
- 失败时是否可诊断。
- 文档是否能让智能体和人都读懂。
