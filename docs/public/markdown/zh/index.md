<!-- 由 docs/zh/index.md 生成。不要直接编辑此副本。 -->

# 概览

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/index.md
- 栏目: 上手

## 面向真实软件的开源 Agent-Computer Interface 运行时

Uni-CLI 在 Agent 与网站、登录态浏览器、桌面应用、本地工具、文件、MCP 服务、accessibility、visual control 和系统能力之间提供一个可搜索边界。它按意图排序已编目 operation，通过选中 operation 已声明的 substrate 按支持的策略运行，返回稳定的成功/错误 envelope，并让支持的失败路径可修复。

## 运行时合同

- Intent discovery
- Declared substrates
- Policy-aware execution
- Structured envelopes
- MCP + ACP
- Browser + Desktop
- Repairable paths

## 第一条命令

```bash
npm install -g @zenalexa/unicli
unicli do "找 Hacker News 首页"
unicli extract https://example.com --max-chars 1200
unicli compute snapshot --app Calculator --format compact
unicli mcp serve --transport streamable --port 19826
```

## 定位

Uni-CLI 是 Agent-Computer Interface runtime，不是 Agent model、planner、浏览器 Agent 或 MCP 平台。CLI 是原生完整进程入口；MCP 投影 adapter operation；API、文件、CLI、browser、desktop、protocol 和 visual 是 operation 可声明的 substrate。精简闭环是发现、选择、治理、行动、观察、修复。

- **发现。** BM25 双语搜索只取当前任务相关的操作、参数、认证姿态和风险字段。
- **选择与治理。** Agent 选择已声明 strategy/substrate 的 operation；执行前可检查当前覆盖的 capability scope、effect、risk 和 approval。
- **行动与观察。** Adapter kernel 调用选中的 operation；AgentEnvelope 区分成功与错误，支持的 operation 可附加 artifact、recording 或 post-state evidence。
- **修复。** 结构化错误始终带 code/message，并在适用时提供 source path、失败边界、retryability、suggestion 或 alternatives。

## 常见任务

- `unicli search` 和 `unicli do` 先查本地操作目录，操作选定后再读取参数、认证、风险和输出字段。
- 页面、接口、App 或本地边界失效时，owned failure 可在 error envelope 中指出 source path、失败 step 或边界。
- Native CLI 是完整 command surface；MCP default/deferred/expanded profile 投影 adapter operation，固定 core 与其他 integration parity 仍在路线图中。

## 覆盖范围

- 静态 adapter 站点：324
- 已注册 adapter 操作：1817
- Built-in action：105（50 registered + 55 transport-native）
- 测试：9816

站点与操作数字来自静态 adapter catalog；固定 core 与主机动态发现命令在运行时单独加入。operation、adapter、built-in action、测试和 substrate 都由本地构建流程计数。

## 入口

- [安装运行](/zh/guide/getting-started)：安装、搜索、执行、认证、输出格式和退出码。
- [操作目录](/zh/reference/sites)：按站点、substrate、认证方式和操作样例检索。
- [适配器](/zh/guide/adapters)：YAML 格式、pipeline step、自修复流程和验证方式。
- [接入 Agent](/zh/guide/integrations)：原生 CLI、MCP、ACP 和可消费输出的取舍。

## 当前版本

当前 latest：v0.400.2 · Apollo · Duke。

## Agent 索引

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
