---
title: 接入 Agent
description: 从 Shell Agent、MCP 客户端和 ACP 客户端调用 Uni-CLI。
---

# 接入 Agent

按 Agent 主机支持的方式连接。Shell 可以使用完整 CLI；MCP 和 ACP 提供协议入口。

## Shell

任何能启动进程的 Agent 都可以调用 Uni-CLI。

```bash
npm install -g @zenalexa/unicli
unicli search "列出 Hacker News 最新文章" -f json
```

给 Agent 加入这段简短指令：

```text
操作网站、App 或本地工具前，先运行 unicli search "<意图>"。
用 unicli describe <site> <command> 查看参数。
选中命令后用 -f json 运行。
```

Codex CLI、Claude Code、OpenCode、OpenClaw、Cursor Agent 和 CI 都可以使用这条路径。

## 平台原生工具

平台维护的 CLI 若能提供更强的结构化契约，Uni-CLI 会直接保留这个执行入口。命令元数据会写明实际 executable，官方 JSON 随后进入统一的 Uni-CLI envelope。

当前第一方路径包括知乎 CLI、X `xurl`、Lark 和飞书 `lark-cli`，以及 Bluesky `goat`。

```bash
unicli zhihu native-search "Agent 工具" -f json
unicli twitter native-search "from:XDevelopers MCP" -f json
unicli lark native-message-search "发布" -f json
unicli bluesky native-resolve bsky.app -f json
```

运行 `unicli ext list --tag social -f json` 可以检查提供方、原生形式、安装状态和能力范围。Reddit Devvit 与 Slack CLI 会明确标为应用开发工具，内容请求不会误入这些入口。Slack 内容命令调用官方 Web API，Slack 托管 MCP 保持独立的 OAuth 服务边界。

Expanded MCP 会把同一组类型化 `native-*` 命令提供给 MCP 客户端。

## MCP

使用 `npx` 启动服务：

```json
{
  "mcpServers": {
    "unicli": {
      "command": "npx",
      "args": ["-y", "@zenalexa/unicli-mcp"]
    }
  }
}
```

对应的终端命令是：

```bash
npx -y @zenalexa/unicli mcp serve
```

查看当前 profile 暴露的工具：

```bash
unicli mcp health -f json
```

默认 profile 保持较小的发现面。客户端需要每条 adapter command 都成为 MCP tool 时，使用 `--expanded`。

## ACP

启动 Agent Client Protocol 服务：

```bash
unicli acp serve
```

用下面的命令查看参数：

```bash
unicli help acp
```

## 登录

在 Agent 主机使用的同一用户和环境中完成认证：

```bash
unicli auth setup <site>
unicli browser profiles --json
unicli auth import <site> --browser chrome
```

详情见[登录与认证](./authentication)。

## 验证连接

让客户端完成一次只读调用：

```text
使用 Uni-CLI 列出三条 Hacker News 热门文章，并返回 JSON。
```

对应命令为：

```bash
unicli hackernews top --limit 3 -f json
```
