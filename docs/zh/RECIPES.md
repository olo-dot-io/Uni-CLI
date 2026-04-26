# 常用配方

这些配方覆盖最常见的使用路径。命令保持英文，因为它们就是实际 CLI 合同。

## 找一个命令并运行

```bash
unicli search "github trending"
unicli github-trending daily --limit 10
```

脚本里用 JSON：

```bash
unicli github-trending daily --limit 10 -f json
```

## 给智能体一个短合同

把这段放进项目的 agent 指令：

```markdown
Use `unicli search "intent"` before choosing a command. Run commands as
`unicli SITE COMMAND [args]`. Prefer `-f json` for scripts and structured
Markdown for human-readable output.
```

## 设置认证

```bash
unicli auth setup SITE
unicli auth check SITE
```

Cookie 文件：

```text
~/.unicli/cookies/SITE.json
```

## 修复命令

```bash
unicli SITE COMMAND
unicli repair SITE COMMAND
```

修复时看错误信封：

- `error.adapter_path`
- `error.step`
- `error.suggestion`
- `error.alternatives`

## 浏览器操作

```bash
unicli operate goto "https://example.com"
unicli operate snapshot
unicli operate click --ref 42
unicli operate type --ref 7 --text "hello"
```

适合临时探索页面，或者为 browser adapter 找 selector。

## MCP 服务

```bash
npx @zenalexa/unicli mcp serve
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
```

## ACP 网关

```bash
unicli acp
```

ACP 只是一条兼容路径。能直接跑 shell 时，优先用 `unicli` 命令。

## 列出能力

```bash
unicli list
unicli list --site macos
unicli list --category desktop
unicli search "office insert image"
```

## 检查项目健康

```bash
npm run verify
npm run docs:build
```

改 adapter 后至少跑：

```bash
npm run lint:adapters
npm run lint:schema-v2
npm run test:adapter
```
