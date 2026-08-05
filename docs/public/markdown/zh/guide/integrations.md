<!-- 由 docs/zh/guide/integrations.md 生成。不要直接编辑此副本。 -->

# 接入 Agent

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/integrations
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/integrations.md
- 栏目: 上手
- 上级: 上手 (/zh/)

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

详情见[登录与认证](/zh/guide/authentication)。

## 验证连接

让客户端完成一次只读调用：

```text
使用 Uni-CLI 列出三条 Hacker News 热门文章，并返回 JSON。
```

对应命令为：

```bash
unicli hackernews top --limit 3 -f json
```
