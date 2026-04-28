<!-- 由 docs/zh/index.md 生成。不要直接编辑此副本。 -->

# 概览

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/index.md
- 栏目: 上手

## 给 Agent 的命令级软件入口

Uni-CLI 把网站、桌面应用、本机工具、MCP 和外部 CLI 放进同一个可搜索目录。Agent 通过一条命令路径完成搜索、执行、记录、修复，再把结果交给任意客户端消费。

## 第一条命令

```bash
npm install -g @zenalexa/unicli
unicli search "connect slack messages"
unicli agents recommend codex
unicli mcp serve --transport streamable --port 19826
```

## 定位

Agent 执行需要一层可审计、可修复、可复用的命令合同。目录搜索负责发现能力，v2 AgentEnvelope 负责稳定输出，operation policy 负责权限和风险，run evidence 负责复盘，自修复 loop 负责把失败指向 adapter 与 pipeline step。

- **发现。** BM25 双语搜索把自然语言意图收敛到具体站点、命令、参数和认证策略。
- **执行。** HTTP、Cookie、浏览器 CDP、桌面 AX、subprocess、service 和 CUA 走同一套 envelope。
- **恢复。** 结构化错误带上 adapter path、step、retryable、suggestion 和 alternatives。

## 常见任务

- `unicli search` 只查本地目录，命令选定后再读取参数、认证、风险和输出字段。
- 页面改版或接口失效时，错误 envelope 指出 adapter 文件和失败的 pipeline step。
- Web API、浏览器、macOS、本地桌面应用、外部 CLI、MCP、ACP、HTTP API 和 agent backend routes 共享目录。

## 覆盖范围

- 站点和工具：235
- 命令：1448
- Pipeline step：59
- 测试：7473

能力规模来自当前仓库生成物：adapter、命令、pipeline step、测试和 transport 都在本地构建流程里计数。

## 入口

- [安装运行](/zh/guide/getting-started)：安装、搜索、执行、认证、输出格式和退出码。
- [命令目录](/zh/reference/sites)：按站点、surface、认证方式和命令样例检索。
- [适配器](/zh/guide/adapters)：YAML 格式、pipeline step、自修复流程和验证方式。
- [接入 Agent](/zh/guide/integrations)：原生 CLI、MCP、ACP 和可消费输出的取舍。

## 当前版本

当前 latest：v0.217.0 · Apollo · Lovell。

## Agent 索引

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
