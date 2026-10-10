---
title: 插件开发
description: 为 Uni-CLI 打包 adapter、pipeline step 与 runtime extension。
---

# 插件开发

插件可以组合可移植的 Agent Skill、Uni-CLI 适配器和运行时扩展。安装后的插件位于 `~/.unicli/plugins/`，启动时加入操作目录。

## 创建 plugin

```bash
unicli plugin create astronomy
cd unicli-plugin-astronomy
```

生成的项目包含以下文件。

```text
unicli-plugin-astronomy/
├── plugin.json
├── unicli-plugin.json
├── skills/
│   └── example/
│       └── SKILL.md
├── README.md
├── adapters/
└── steps/
```

## Portable manifest

`plugin.json` 遵循 [Agent Plugins 1.0](https://agent-plugins.org/specification)，只接受规范声明的字段。Uni-CLI 从 `skills/` 的直接子目录发现 Skill，并将每个有效 Skill 加入操作目录，名称为 `agent-plugin.<plugin-name>.<skill-name>`。可移植 Skill 作为指令加载，其中的 Uni-CLI `pipeline` 字段不会被执行。

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "astronomy",
  "version": "1.0.0",
  "description": "Portable astronomy skills",
  "extensions": {
    "dev.unicli": {
      "manifest": "./unicli-plugin.json"
    }
  }
}
```

安装前可以检查本地包，安装后可以按名称检查。

```bash
unicli plugin inspect ./unicli-plugin-astronomy -f json
unicli plugin inspect astronomy -f json
```

可选的根目录 `mcp.json` 作为客户端配置接受检查。Uni-CLI 报告支持的服务描述类型；这些服务由安装插件的客户端负责启动、连接和权限管理，保持在 Uni-CLI 操作目录之外。MCP 配置无效时，其他有效 Skill 仍可加载。

## Uni-CLI runtime manifest

`unicli-plugin.json` 声明原生适配器、自定义流水线步骤和可选的 JavaScript 入口。

```json
{
  "name": "astronomy",
  "version": "1.0.0",
  "unicli": ">=1.2.0",
  "description": "Astronomy operations for Uni-CLI",
  "adapters": "adapters/",
  "steps": "steps/",
  "main": "dist/index.js"
}
```

`adapters`、`steps` 和 `main` 都是插件目录中的路径，按包内实际内容填写。`plugin.json` 出现致命错误时，该包面向客户端的运行时扩展也会停止加载。

## 添加 adapter

插件 YAML 与包内适配器使用同一 Schema。

```yaml
site: observatory
name: objects
description: Search the observatory object catalog
type: web-api
strategy: public
operation_effect: read
execution_operator: structured-api
operation_family: search

args:
  query:
    type: str
    required: true
    positional: true

pipeline:
  - fetch:
      url: https://example.org/api/objects
      params:
        q: ${{ args.query }}
  - select: data

capabilities: ["http.fetch"]
minimum_capability: http.fetch
trust: user
confidentiality: public
quarantine: false
schema_version: v2
```

完整字段见[适配器格式](/zh/ADAPTER-FORMAT)。

## 添加 pipeline step

从 `@zenalexa/unicli/engine/registry` 导入公开步骤注册表，再在插件入口中注册步骤。

```typescript
import { registerStep } from "@zenalexa/unicli/engine/registry";

registerStep("astronomy_normalize", (ctx, config) => {
  return { ...ctx, data: normalizeCatalog(ctx.data, config) };
});
```

用下面的命令查看已加载的自定义步骤。

```bash
unicli plugin steps
```

## Public package imports

Uni-CLI 为注册表、错误、类型、输出、引擎、传输、浏览器辅助函数、协议 Schema 和下载功能提供带版本约定的包子路径。下面的导入使用这些公开入口。

```typescript
import { cli } from "@zenalexa/unicli/registry";
import { err, ok } from "@zenalexa/unicli/errors";
import type { AdapterCommand } from "@zenalexa/unicli/types";
import { registerStep } from "@zenalexa/unicli/engine/registry";
import { getTransportBus } from "@zenalexa/unicli/transport";
```

通过包导出导入功能，避免依赖内部构建目录。

## Broker 管理的浏览器调用

需要浏览器的插件共享本机 Browser Runtime Broker。Broker 管理浏览器进程、端口、运行时复用、登录分区和目标的串行访问。插件为每次调用提供 Agent 身份和浏览器选择策略。

```typescript
import {
  BrowserBridge,
  createBrowserInvocationContext,
  createBrowserInvocationScope,
  runBrowserInvocation,
} from "@zenalexa/unicli/browser/runtime";

const context = createBrowserInvocationContext({
  transport: "plugin",
  agentSessionId: hostThreadId,
  turnId: hostTurnId,
  profilePartitionId: "team-login",
});

const scope = createBrowserInvocationScope({
  context,
  provider: "managed",
  visibility: "hidden",
  profilePartitionId: "team-login",
});

const snapshot = await runBrowserInvocation(scope, async () => {
  const page = await new BrowserBridge().connect();
  await page.goto("https://example.com");
  return page.snapshot({ interactive: true });
});
```

托管浏览器使用 `managed` 与 `hidden`，已有 Chrome 使用 `chrome` 与 `background` 或 `foreground`，远程浏览器使用 `remote` 与 `hidden`。`probeBrowserRuntimeBroker()` 读取当前状态，`ensureBrowserRuntimeBroker()` 启动无窗口协调服务。第一次页面命令会启动选中的浏览器。

## 安装与管理

```bash
unicli plugin install ./unicli-plugin-astronomy
unicli plugin install github:owner/repository
unicli plugin list
unicli plugin update astronomy
unicli plugin uninstall astronomy
```

安装后检查新加入的命令。

```bash
unicli search "search observatory objects"
unicli describe observatory objects
```

## 发布前检查

- 设置语义化版本和 Uni-CLI 兼容版本范围。
- 每条适配器都提供面向用户的描述及 schema-v2 元数据。
- 凭据使用 Uni-CLI 认证存储或主机环境变量。
- 通过公开导入路径验证自定义步骤和适配器行为。
- README 说明安装、命令、认证和一个可运行示例。
