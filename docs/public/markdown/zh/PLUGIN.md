<!-- 由 docs/zh/PLUGIN.md 生成。不要直接编辑此副本。 -->

# 插件开发

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/PLUGIN
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/PLUGIN.md
- 栏目: 扩展
- 上级: 扩展 (/zh/guide/adapters)

Plugin 可以组合 portable Agent Skill、Uni-CLI adapter 和 runtime extension。安装后的 plugin 位于 `~/.unicli/plugins/`，并在启动时加入 runtime catalog。

## 创建 plugin

```bash
unicli plugin create astronomy
cd unicli-plugin-astronomy
```

Scaffold 包含以下文件。

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

`plugin.json` 遵循 [Agent Plugins 1.0](https://agent-plugins.org/specification)。Uni-CLI 会验证 closed manifest，发现 `skills/` 下的直接子目录，并把每个有效 Skill 投影为 operation catalog 中的 `agent-plugin.<plugin-name>.<skill-name>`。Portable Skill 始终按 instruction 加载，即使 frontmatter 含有 Uni-CLI `pipeline` 字段也不会执行。

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

安装前可以检查本地 package，安装后也可以按名称检查。

```bash
unicli plugin inspect ./unicli-plugin-astronomy -f json
unicli plugin inspect astronomy -f json
```

可选的根目录 `mcp.json` 会逐项验证。有效 config 会生成只读的 `agent-plugin.<plugin-name>.__mcp_servers` 描述 operation，并保持 `configuration-only`。Portable loader 不会启动或连接这些 server。MCP config 无效时，其他有效 Skill 仍可加载。

## Uni-CLI runtime manifest

`unicli-plugin.json` 声明 native adapter、custom pipeline step 和可选 JavaScript entry point。

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

`adapters`、`steps` 和 `main` 都是 plugin 目录中的路径。按 package 实际内容填写。`plugin.json` 出现 fatal error 时，该 package 的 client-specific runtime 也不会加载。

## 添加 adapter

Plugin YAML 与 packaged adapter 使用同一 schema。

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

从 `@zenalexa/unicli/engine/registry` 导入 public step registry，然后在 plugin entry point 注册。

```typescript
import { registerStep } from "@zenalexa/unicli/engine/registry";

registerStep("astronomy_normalize", (ctx, config) => {
  return { ...ctx, data: normalizeCatalog(ctx.data, config) };
});
```

用下面的命令查看已加载的 custom step。

```bash
unicli plugin steps
```

## Public package imports

Uni-CLI 为 registry、errors、types、output、engine、transport、browser helper、protocol schema 和 download 发布 versioned subpath。下面的 import 使用这组公开入口。

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

安装后检查新目录项。

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
