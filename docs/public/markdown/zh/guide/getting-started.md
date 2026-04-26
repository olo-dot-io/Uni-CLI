<!-- 由 docs/zh/guide/getting-started.md 生成。不要直接编辑此副本。 -->

# 快速开始

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/getting-started
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/getting-started.md
- 栏目: 开始
- 上级: 开始 (/zh/)

Uni-CLI 把网站、桌面应用、服务和本地工具变成命令。智能体可以搜索它们、运行它们，并在命令坏掉时修复它们。

## 安装

```bash
npm install -g @zenalexa/unicli
unicli --version
```

需要 Node.js 20 或更高版本。

所有命令都长成同一种形状：

```bash
unicli SITE COMMAND [args] [-f json|md|yaml|csv|compact]
```

默认输出是 Markdown，适合智能体和人一起读。脚本或程序要消费结果时，用 `-f json`。

## 找命令

```bash
unicli search "hacker news frontpage"
unicli search "github trending"
unicli list --site hackernews
```

`search` 接受自然语言。你不需要先记住站点名和命令名。

## 运行命令

```bash
unicli hackernews top --limit 5
```

脚本里使用 JSON：

```bash
unicli hackernews top --limit 5 -f json | jq '.[0]'
```

支持的输出格式：

```bash
unicli hackernews top -f md
unicli hackernews top -f json
unicli hackernews top -f yaml
unicli hackernews top -f csv
unicli hackernews top -f compact
```

## 认证

有些 adapter 需要本地 Cookie：

```bash
unicli auth setup bilibili
unicli auth check bilibili
unicli bilibili feed
```

Cookie 放在 `~/.unicli/cookies/SITE.json`。认证失败会返回退出码 `77`，错误信封里会给出下一步该运行的命令。

## 修复坏掉的命令

命令失败时，先读结构化错误。它会指出需要关注的 adapter 文件和 pipeline step。

```bash
unicli repair SITE COMMAND
```

常见循环：

```text
1. 读取 error.adapter_path 和 error.step。
2. 修改 YAML adapter。
3. 保存到 ~/.unicli/adapters/SITE/COMMAND.yaml 作为本地覆盖。
4. 重新运行 unicli repair SITE COMMAND。
```

## 浏览器自动化

当 HTTP 不够用时，browser adapter 会通过 Chrome/CDP 操作页面。

```bash
unicli operate goto "https://example.com"
unicli operate snapshot
unicli operate click --ref 42
unicli operate type --ref 7 --text "hello"
unicli operate screenshot --path ./page.png
```

## 协议服务

MCP：

```bash
npx @zenalexa/unicli mcp serve
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
```

ACP：

```bash
unicli acp
```

ACP 是编辑器兼容网关。coding-agent 运行时路由优先看：

```bash
unicli agents matrix
unicli agents recommend codex
```

## 退出码

| 代码 | 含义       | 智能体该怎么做                |
| ---- | ---------- | ----------------------------- |
| 0    | 成功       | 使用返回数据                  |
| 66   | 空结果     | 换参数再试                    |
| 69   | 服务不可用 | 稍后重试                      |
| 75   | 临时失败   | 退避重试                      |
| 77   | 需要认证   | 运行 `unicli auth setup SITE` |
| 78   | 配置错误   | 读取错误信封和 adapter YAML   |

## 下一步

- [适配器](/zh/guide/adapters)
- [集成方式](/zh/guide/integrations)
- [自修复](/zh/guide/self-repair)
- [管线步骤](/zh/reference/pipeline)
- [退出码](/zh/reference/exit-codes)
