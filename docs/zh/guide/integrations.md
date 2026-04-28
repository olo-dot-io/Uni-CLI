# 集成方式

Uni-CLI 的首选入口是 shell。只要智能体能运行命令，就可以直接使用 `unicli`。需要协议服务的客户端，可以用同一份目录通过 MCP、ACP 或生成的平台配置接入；adapter 行为保持一致。

## 选哪条路

| 客户端需要什么                 | 用什么                                           |
| ------------------------------ | ------------------------------------------------ |
| 能运行 shell 命令              | 原生 `unicli` CLI                                |
| 需要 MCP tool calls            | `unicli mcp serve`                               |
| 需要 ACP prompt/session frames | `unicli acp`                                     |
| 需要生成平台配置               | `unicli agents generate`                         |
| 需要选择运行后端               | `unicli agents matrix` / `recommend`             |
| 需要本地 skills 发现           | `unicli skills export` / `unicli skills publish` |

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

高风险命令可以先检查：

```bash
unicli describe SITE COMMAND
unicli SITE COMMAND --dry-run
unicli SITE COMMAND --record
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

旧版 SSE 兼容：

```bash
npx @zenalexa/unicli mcp serve --transport sse --port 19826
```

`sse` 是 Streamable transport 的旧别名，新配置优先使用
`--transport streamable`。

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

`mcp serve` 和 `acp` 保持原始 stdio 协议行为。常规命令面返回 v2 `AgentEnvelope`。

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

ACP 是编辑器兼容路径。结构化 tool calls 走 MCP，prompt/session frames 走 ACP。

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

后端推荐会显式建模 native CLI、JSON stream、MCP、ACP、HTTP API、OpenAI-compatible routes、bridge CLIs 和 CUA candidates。

## Skills

当 agent runtime 有本地 skills 目录时，可以把 adapter 命令导出成 `SKILL.md`：

```bash
unicli skills export
unicli skills publish --to ~/.cursor/skills/uni-cli/
unicli skills catalog --out /tmp/unicli-skills.json
```

生成文件包含命令名、使用场景、认证提示和调用示例。它适合和运行时搜索一起使用。

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
