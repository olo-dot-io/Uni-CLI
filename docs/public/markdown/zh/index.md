<!-- 由 docs/zh/index.md 生成。不要直接编辑此副本。 -->

# 概览

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/index.md
- 栏目: 上手

## 面向 Agent 的软件执行层

Agent 正从聊天助手走向任务执行系统：它需要调用 CLI、API、浏览器和桌面应用，也需要审计记录、权限边界和失败后的恢复路径。Uni-CLI 把这些软件入口整理成同一套可搜索、可执行、可追踪、可修复的命令接口。

## 第一条命令

```bash
npm install -g @zenalexa/unicli
unicli search "twitter trending"
unicli twitter trends --limit 10 -f json
```

## 定位

不是再造一个协议层，而是补齐 Agent 执行的工程面。MCP 解决互操作，browser / computer-use 补 API 空白；真正进入生产环境时，还需要命令目录、权限策略、可审计输出、退出码和修复循环。

- **统一入口。** 同一个目录覆盖公开 API、Cookie 会话、浏览器、桌面应用、外部 CLI 和本机能力。
- **可审计执行。** 参数、认证、权限 profile、输出结构和退出码在运行前后都能检查，不靠 prompt 约定。
- **可恢复失败。** 外部页面或 API 变了，错误要指向 adapter 文件、pipeline step 和复现命令。

## 覆盖范围

- 站点和工具：235
- 命令：1448
- Pipeline step：59
- 输出协议：v2 AgentEnvelope

同一套调用路径覆盖公开 API、Cookie 会话、浏览器、桌面应用、外部 CLI 和本机能力。Agent 只需要学一条调用路径。

## 入口

- [安装运行](/zh/guide/getting-started)：安装、搜索、运行、认证和常见退出码。
- [命令目录](/zh/reference/sites)：按站点、接口类型、认证方式和命令样例检索。
- [适配器](/zh/guide/adapters)：YAML 格式、pipeline step、自修复流程和验证方式。

## 当前版本

当前 latest：v0.217.0 · Apollo · Lovell。

## Agent 索引

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
