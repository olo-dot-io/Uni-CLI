---
title: 插件开发
description: 为 Uni-CLI 打包 adapter、pipeline step 与 runtime extension。
---

# 插件开发

Plugin 把 adapter 和可选 JavaScript extension 组织在主仓库外。安装后的 plugin 位于 `~/.unicli/plugins/`，并在启动时加入 runtime catalog。

## 创建 plugin

```bash
unicli plugin create astronomy
cd unicli-plugin-astronomy
```

Scaffold 包含：

```text
unicli-plugin-astronomy/
├── unicli-plugin.json
├── README.md
├── adapters/
└── steps/
```

## Manifest

```json
{
  "name": "astronomy",
  "version": "1.0.0",
  "unicli": ">=0.206.0",
  "description": "Astronomy operations for Uni-CLI",
  "adapters": "adapters/",
  "steps": "steps/",
  "main": "dist/index.js"
}
```

`adapters`、`steps` 和 `main` 都是 plugin 目录中的路径。按 package 实际内容填写。

## 添加 adapter

Plugin YAML 与 packaged adapter 使用同一 schema：

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

从 `@zenalexa/unicli/engine/registry` 导入 public step registry，在 plugin entry point 注册：

```typescript
import { registerStep } from "@zenalexa/unicli/engine/registry";

registerStep("astronomy_normalize", (ctx, config) => {
  return { ...ctx, data: normalizeCatalog(ctx.data, config) };
});
```

查看已加载的 custom step：

```bash
unicli plugin steps
```

## Public package imports

Uni-CLI 为 registry、errors、types、output、engine、transport、browser helper、protocol schema 和 download 发布 versioned subpath：

```typescript
import { cli } from "@zenalexa/unicli/registry";
import { err, ok } from "@zenalexa/unicli/errors";
import type { AdapterCommand } from "@zenalexa/unicli/types";
import { registerStep } from "@zenalexa/unicli/engine/registry";
import { getTransportBus } from "@zenalexa/unicli/transport";
```

使用 package export 可以让 import 跟随支持的 public surface。

## Broker 管理的浏览器调用

需要浏览器的 plugin 共享 Uni-CLI 的机器级 Browser Runtime Broker。Broker 负责浏览器进程、端口、runtime 复用、登录分区和 target 串行化；plugin 为每次调用提供 Agent 身份和 provider 策略。

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

Managed provider 使用 `managed` 与 `hidden`；已有 Chrome 使用 `chrome` 与 `background` 或 `foreground`；远程 provider 使用 `remote` 与 `hidden`。`probeBrowserRuntimeBroker()` 读取当前状态，`ensureBrowserRuntimeBroker()` 启动无窗口控制面，第一次 page command 会启动选中的 provider。

## 安装与管理

```bash
unicli plugin install ./unicli-plugin-astronomy
unicli plugin install github:owner/repository
unicli plugin list
unicli plugin update astronomy
unicli plugin uninstall astronomy
```

安装后检查新目录项：

```bash
unicli search "search observatory objects"
unicli describe observatory objects
```

## 发布前检查

- 设置 semantic version 与 Uni-CLI compatibility range。
- 每条 adapter 都有面向用户的 description 和当前 schema-v2 metadata。
- 凭据放在 Uni-CLI auth storage 或 host environment。
- 通过 public import 测试 custom step 和 adapter behavior。
- README 说明安装、命令、认证和一个可运行示例。
