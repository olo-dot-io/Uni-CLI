# 架构

Uni-CLI 的目标是把真实软件操作变成智能体原生可用的 CLI 命令。它的核心不是协议，而是一个可发现、可执行、可验证、可修复的命令层。

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
Transports: HTTP, browser/CDP, desktop, subprocess, service
  ↓
Websites, desktop apps, local tools, external CLIs
```

## 关键模块

| 模块       | 职责                                          |
| ---------- | --------------------------------------------- |
| CLI        | 解析命令、选择输出格式、返回退出码。          |
| Search     | 用 BM25 和别名把自然语言意图映射到命令。      |
| Registry   | 加载 YAML/TypeScript adapter，生成 manifest。 |
| Engine     | 执行 pipeline steps，处理变量、错误和输出。   |
| Transports | 连接 HTTP、浏览器、桌面、本地命令和服务。     |
| Output     | 把结果包装成 v2 `AgentEnvelope`。             |
| Repair     | 让失败结果指向可修复的 adapter 和 step。      |

## 为什么 CLI-first

智能体已经能运行 shell。CLI-first 的好处是：

- 不需要为每个客户端复制一套协议适配。
- 容易组合：pipe、redirect、jq、shell scripts 都能用。
- 错误能用退出码快速路由。
- 输出可以同时服务人和机器。
- 本地覆盖和修复不依赖远端服务。

MCP、ACP 等协议接口仍然提供，但它们是兼容层，不是核心运行时。

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
