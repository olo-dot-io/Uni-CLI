<!-- 由 docs/zh/guide/integrations.md 生成。不要直接编辑此副本。 -->

# 集成方式

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/integrations
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/integrations.md
- 栏目: 开始
- 上级: 开始 (/zh/)

Uni-CLI 的首选入口是 shell。只要智能体能运行命令，就可以直接使用 `unicli`。需要协议服务的客户端，可以用同一份目录通过 MCP 或 ACP 接入；adapter 行为不会变。

## 选哪条路

| 客户端需要什么                 | 用什么                   |
| ------------------------------ | ------------------------ |
| 能运行 shell 命令              | 原生 `unicli` CLI        |
| 需要 MCP tool calls            | `unicli mcp serve`       |
| 需要 ACP prompt/session frames | `unicli acp`             |
| 需要生成平台配置               | `unicli agents generate` |

如果智能体有 shell 权限，优先用原生 CLI。它发现命令更懒加载，输出更小，也保留 Unix 组合能力。

## 原生 CLI

```bash
unicli search "hacker news frontpage"
unicli hackernews top --limit 5 -f json
```

可以把这段短合同放进 `AGENTS.md`、`CLAUDE.md` 或等价的 agent context 文件：

```markdown
Use `unicli search "intent"` before choosing a command. Run commands as
`unicli SITE COMMAND [args]`. Prefer `-f json` for scripts and structured
Markdown for human-readable agent output.
```

## MCP

启动 stdio server：

```bash
npx @zenalexa/unicli mcp serve
```

启动 Streamable HTTP server：

```bash
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
```

SSE 兼容：

```bash
npx @zenalexa/unicli mcp serve --transport sse --port 19826
```

远程部署可以打开 OAuth 2.1 PKCE：

```bash
npx @zenalexa/unicli mcp serve --transport streamable --port 19826 --auth
```

默认 MCP tools：

| Tool             | 用途                     |
| ---------------- | ------------------------ |
| `unicli_search`  | 按自然语言意图搜索命令。 |
| `unicli_run`     | 运行选中的站点命令。     |
| `unicli_list`    | 列出站点和命令。         |
| `unicli_explore` | 写 adapter 前检查页面。  |

stdio 配置示例：

```json
{
  "mcpServers": {
    "unicli": {
      "command": "npx",
      "args": ["@zenalexa/unicli", "mcp", "serve"]
    }
  }
}
```

TOML 配置示例：

```toml
[mcp_servers.unicli]
command = "npx"
args = ["@zenalexa/unicli", "mcp", "serve"]
```

## ACP

ACP 是编辑器兼容路径。客户端如果需要结构化 tool calls，用 MCP；如果它期待 prompt/session frames，用 ACP。

```bash
unicli acp
```

最小 provider 示例：

```lua
require("avante").setup({
  providers = {
    {
      name = "unicli",
      command = "unicli",
      args = { "acp" },
      type = "acp",
    },
  },
})
```

ACP prompt 里最好直接给命令：

```text
Show the top 10 HN posts:
unicli hackernews top --limit 10
```

## Agent 平台配方

能生成配置时，不要手写：

```bash
unicli agents matrix
unicli agents recommend codex
unicli agents generate --for claude
unicli agents generate --for codex
unicli agents generate --for opencode
```

手动示例：

```bash
claude mcp add unicli -- npx @zenalexa/unicli mcp serve
```

```jsonc
{
  "mcp": {
    "unicli": {
      "type": "local",
      "command": ["npx", "-y", "@zenalexa/unicli", "mcp", "serve"],
      "enabled": true,
    },
  },
}
```

## 认证

所有集成路径都使用同一套本地凭据：

```bash
unicli auth setup SITE
unicli auth check SITE
```

Cookie 路径：

```text
~/.unicli/cookies/SITE.json
```

## 验证

```bash
unicli list
unicli search "hacker news frontpage"
unicli hackernews top --limit 5
```
