# 快速开始

Uni-CLI 把网站、桌面应用、服务、本地工具、协议入口和外部 CLI 变成命令。智能体可以搜索、运行、记录和修复这些命令。

一条命令就是调用真实软件的稳定合同。参数、认证、接口类型、输出形状、权限 profile、运行证据和错误处理都在同一个地方；外部页面或 API 变了，失败结果也会指向可修复的 adapter 和 pipeline step。

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

## 先理解执行链路

Uni-CLI 的常用路径分成四步：

1. **搜索**：`unicli search` 用自然语言找到候选命令，但不执行外部动作。
2. **执行**：`unicli SITE COMMAND` 只运行选中的命令，参数和认证边界在执行前可检查。
3. **记录**：`--record` 或 `UNICLI_RECORD_RUN=1` 可以把 append-only run trace 写到 `~/.unicli/runs`，方便复盘和调试。
4. **修复**：命令坏掉时，结构化错误会给出 adapter 路径、pipeline step、建议和替代命令。

浏览器、CDP、a11y、本地命令、服务接口、MCP、ACP 和 CUA 都是传输层；稳定层是命令目录、adapter 和 v2 `AgentEnvelope`。

## 找命令

```bash
unicli search "hacker news frontpage"
unicli search "github trending"
unicli list --site hackernews
```

`search` 接受自然语言。你不需要先记住站点名和命令名。

搜索结果用于缩小候选范围。真正要跑之前，仍然应该看清命令名、参数、认证要求和接口类型。这样 Agent 不需要把整个站点目录塞进上下文，也不会把“找到了可能的操作”和“已经执行操作”混在一起。

## 运行命令

```bash
unicli hackernews top --limit 5
```

这条命令默认返回 Markdown，里面包含数据、上下文和下一步建议。非 TTY 或 agent UA 环境下也会优先给可读 Markdown，便于在聊天记录和终端日志里审阅。

脚本里使用 JSON：

```bash
unicli hackernews top --limit 5 -f json | jq '.[0]'
```

支持的输出格式和自动选择顺序：

```bash
unicli hackernews top -f md
unicli hackernews top -f json
unicli hackernews top -f yaml
unicli hackernews top -f csv
unicli hackernews top -f compact
```

优先级是 `-f` 参数、`UNICLI_OUTPUT`、agent / non-TTY 检测、Markdown。Agent UA 环境变量包括 `CLAUDE_CODE`、`CODEX_CLI`、`OPENCODE`、`HERMES_AGENT` 和 `UNICLI_AGENT`。

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

修复的目标是让命令重新符合公开输出形状。YAML adapter 通常只有几十行，适合 Agent 读取、修改、diff 和验证；需要复杂运行时代码时再使用 TypeScript adapter。

## 浏览器自动化

当 HTTP 不够用时，browser adapter 会通过 Chrome/CDP 操作页面。

```bash
unicli operate goto "https://example.com"
unicli operate snapshot
unicli operate click --ref 42
unicli operate type --ref 7 --text "hello"
unicli operate screenshot --path ./page.png
```

浏览器动作可以附带前后证据、stale-ref 细节、移动维度、watchdog 结果、
session lease、tab 目标身份、cookie 姿态和 render-aware 读取，方便审查。

```bash
unicli browser evidence --render-aware --expect-domain example.com
unicli browser extract --render-aware --expect-domain example.com --no-screenshot
unicli runs list
unicli runs show <run_id>
unicli runs probe <run_id>
unicli runs replay <run_id> --permission-profile confirm --yes
unicli runs compare <run_id> <replay_run_id>
unicli --permission-profile locked --yes --remember-approval word set-font "Inter"
unicli approvals list
unicli approvals revoke <approval_key>
```

记住的审批会绑定命令 capability 和稳定资源 metadata，比如域名、应用、账号面和路径参数槽。
原始运行参数不会写进 approval store。

## 协议服务

MCP：

```bash
npx @zenalexa/unicli mcp serve
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
npx @zenalexa/unicli mcp serve --transport streamable --port 19826 --auth
```

`--transport sse` 仍然是 Streamable 的旧别名，但新部署优先使用
`--transport streamable`。

ACP：

```bash
unicli acp
```

ACP 是编辑器兼容网关。coding-agent 运行时路由优先看：

```bash
unicli agents matrix
unicli agents recommend codex
unicli agents generate --for codex
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
