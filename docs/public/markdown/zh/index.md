<!-- 由 docs/zh/index.md 生成。不要直接编辑此副本。 -->

# 概览

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/index.md
- 栏目: 上手

## AI Agent 控制 computer 的通用平台

Uni-CLI 把网站、登录态浏览器、桌面应用、本地工具、文件、MCP 服务、无障碍树、截图和系统能力收进一套可搜索、可治理、可观察、可修复的操作层。Agent 先按意图选择行动 substrate，再按策略执行，拿到证据回执；失败时还能诊断、修复或换路，直到结果交付。

## 控制面

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

Agent 执行需要的不是更长的常驻工具列表，也不是又一个网页 wrapper。它需要一只可以控制整台 computer 的通用手。operation search 负责发现操作，operation policy 负责权限和风险，control kernel 负责选择 substrate，v2 AgentEnvelope 负责稳定输出，run evidence 负责复盘，delivery/repair loop 负责把失败指向 source path、替代路径和验证命令。

- **理解意图。** BM25 双语搜索把自然语言意图收敛到具体站点、操作、参数、认证姿态和风险字段。
- **选择 substrate。** HTTP、Cookie、浏览器 CDP、macOS AX、subprocess、service、protocol 和 visual fallback 走同一套 control kernel。
- **返回证据。** Markdown 是 Agent 默认友好的输出，JSON、YAML、CSV 和 compact 负责程序接入。
- **修复或换路。** 结构化错误带上 source path、step 或边界、retryable、suggestion 和 alternatives。

## 常见任务

- `unicli search` 和 `unicli do` 先查本地操作目录，操作选定后再读取参数、认证、风险和输出字段。
- 页面、接口、App 或本地边界失效时，错误 envelope 指出 source path、失败 step 或边界。
- Web API、浏览器、macOS、本地桌面应用、外部 CLI、文件、MCP、ACP、HTTP API 和 agent backend routes 共享同一套 operation contract 与回执。

## 覆盖范围

- 站点和工具：320
- 操作：1798
- Pipeline step：103
- 测试：9256

能力规模来自当前仓库生成物：operation、adapter、pipeline step、测试和 substrate 都在本地构建流程里计数。

## 入口

- [安装运行](/zh/guide/getting-started)：安装、搜索、执行、认证、输出格式和退出码。
- [操作目录](/zh/reference/sites)：按站点、substrate、认证方式和操作样例检索。
- [适配器](/zh/guide/adapters)：YAML 格式、pipeline step、自修复流程和验证方式。
- [接入 Agent](/zh/guide/integrations)：原生 CLI、MCP、ACP 和可消费输出的取舍。

## 当前版本

当前 latest：v0.226.0 · Apollo · Stafford。

## Agent 索引

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
