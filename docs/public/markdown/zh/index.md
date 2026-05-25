<!-- 由 docs/zh/index.md 生成。不要直接编辑此副本。 -->

# 概览

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/index.md
- 栏目: 上手

## Agent 操作真实软件的执行底座

Uni-CLI 把网站、登录态浏览器、桌面应用、本地工具、MCP 服务和系统能力收进一套可搜索、可治理、可修复的操作层。Agent 先按意图找能力，再按策略执行，拿到证据回执；失败时还能定位到具体的 adapter 和 pipeline step 继续修。

## 能力墙

- Intent search
- Policy-gated execution
- AgentEnvelope v2
- MCP + ACP
- Desktop AX
- Visual fallback
- Adapter self-repair

## 第一条命令

```bash
npm install -g @zenalexa/unicli
unicli do "找 Hacker News 首页"
unicli extract https://example.com --max-chars 1200
unicli compute snapshot --app Calculator --format compact
unicli mcp serve --transport streamable --port 19826
```

## 定位

Agent 执行需要的不是更长的常驻工具列表，也不是又一个网页 wrapper。它需要一层小而稳定、可审计、可修复的执行底座。目录搜索负责发现能力，operation policy 负责权限和风险，v2 AgentEnvelope 负责稳定输出，run evidence 负责复盘，自修复 loop 负责把失败指向 adapter 与 pipeline step。

- **发现能力。** BM25 双语搜索把自然语言意图收敛到具体站点、命令、参数、认证策略和风险字段。
- **执行动作。** HTTP、Cookie、浏览器 CDP、macOS AX、subprocess、service 和 visual fallback 走同一套 envelope。
- **返回证据。** Markdown 是 Agent 默认友好的输出，JSON、YAML、CSV 和 compact 负责程序接入。
- **修复现场。** 结构化错误带上 adapter path、step、retryable、suggestion 和 alternatives。

## 常见任务

- `unicli search` 和 `unicli do` 先查本地目录，命令选定后再读取参数、认证、风险和输出字段。
- 页面改版或接口失效时，错误 envelope 指出 adapter 文件和失败的 pipeline step。
- Web API、浏览器、macOS、本地桌面应用、外部 CLI、MCP、ACP、HTTP API 和 agent backend routes 共享同一套目录与回执。

## 覆盖范围

- 站点和工具：311
- 命令：1753
- Pipeline step：103
- 测试：8915

能力规模来自当前仓库生成物：adapter、命令、pipeline step、测试和 transport 都在本地构建流程里计数。

## 入口

- [安装运行](/zh/guide/getting-started)：安装、搜索、执行、认证、输出格式和退出码。
- [命令目录](/zh/reference/sites)：按站点、surface、认证方式和命令样例检索。
- [适配器](/zh/guide/adapters)：YAML 格式、pipeline step、自修复流程和验证方式。
- [接入 Agent](/zh/guide/integrations)：原生 CLI、MCP、ACP 和可消费输出的取舍。

## 当前版本

当前 latest：v0.223.1 · Apollo · Lovell。

## Agent 索引

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
