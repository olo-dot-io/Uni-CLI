<!-- 由 docs/zh/how-it-works.md 生成。不要直接编辑此副本。 -->

# 工作原理

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/how-it-works
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/how-it-works.md
- 栏目: 上手
- 上级: 上手 (/zh/)

Uni-CLI 为网站、浏览器、桌面 App、本地工具、文件和协议服务提供统一命令模型。每次调用都经过四个步骤。运行时查找操作并查看合同，通过声明的接口运行，随后返回结构化结果。

## 1. 在本地查找操作

```bash
unicli search "查看 Hacker News 热门文章"
```

搜索在已安装目录中完成。运行时只编译一次任务，解析精确或带拼写误差的 provider 名称，再对中英文命令描述排序。Effect、operator、target surface、category 和 platform 过滤会在检索阶段移除不兼容命令。每条结果都带有具名排序信号。Discovery 不会执行外部操作。

## 2. 操作会说明自己的参数

```bash
unicli describe hackernews top
```

操作合同包含以下字段。

- 参数和默认值
- 登录要求
- 目标 surface 与 execution operator
- effect 与 interaction impact
- adapter 源文件和修复入口

Agent 可以在打开浏览器、启动桌面 provider 或访问服务前准备好调用。

## 3. 通过声明的接口执行

一条操作可以使用 structured API、browser protocol、native CLI、browser semantics、desktop accessibility、visual control 或 local runtime。目录通过 `operator` 和 `minimum_capability` 记录选择。

```bash
unicli hackernews top --limit 5 -f json
```

参数可以来自 Shell flag、stdin JSON 或 args file。运行时会先验证参数，再取得目标接口。

## 4. 每次调用都返回 envelope

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "hackernews.top",
  "meta": {
    "duration_ms": 2853,
    "count": 5,
    "surface": "web"
  },
  "data": [],
  "error": null
}
```

成功和失败共享同一外层结构。程序可根据 `ok` 分支，从 `data` 读取结果，并用 `error.code` 选择下一步。

## 软件发生变化时

adapter failure 可以指出源文件和失败步骤。更新 adapter 后，`repair` 会重新运行原命令完成验证。

```bash
unicli repair <site> <command> --dry-run
unicli repair <site> <command>
```

`~/.unicli/adapters/` 中的用户 adapter 可在本地开发时覆盖 packaged adapter。

## CLI、MCP 与 ACP

CLI 提供完整命令面，适合进程型 Agent、管道、文件和 CI。MCP 把 Uni-CLI 接入 tool server 客户端。ACP 提供 agent-client server。三种入口使用同一操作目录。

## 继续阅读

- [快速开始](/zh/guide/getting-started)
- [查找操作](/zh/guide/)
- [登录与认证](/zh/guide/authentication)
- [架构](/zh/ARCHITECTURE)
