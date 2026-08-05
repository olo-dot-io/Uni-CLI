---
title: 快速开始
description: 安装 Uni-CLI，查找操作，并在几分钟内完成第一次调用。
---

# 快速开始

安装 Uni-CLI，描述想要的结果，再运行选中的操作。

## 准备工作

- Node.js 22.19 或更新版本
- npm

## 1. 安装

```bash
npm install -g @zenalexa/unicli
```

确认版本：

```bash
unicli --version
```

## 2. 按意图搜索

```bash
unicli search "查看 Hacker News 热门文章"
```

结果会显示匹配的命令、接口类型、操作效果和目标。

## 3. 查看参数

```bash
unicli describe hackernews top
```

`describe` 会给出可用参数和调用示例，适合让 Agent 在执行前准备好参数。

## 4. 运行操作

```bash
unicli hackernews top --limit 5 -f json
```

成功结果使用 v2 envelope：

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "hackernews.top",
  "data": [{ "rank": "1", "title": "...", "url": "https://..." }],
  "error": null
}
```

## 交给 Agent 使用

把下面这段话发给能运行 Shell 的 Agent：

```text
用 npm install -g @zenalexa/unicli 安装 Uni-CLI。
操作网站、App 或本地工具前，先运行 unicli search "<意图>"。
用 unicli describe <site> <command> 查看参数，再用 -f json 运行。
遇到登录要求时，执行 error envelope 中的 suggestion。
```

MCP、Claude Desktop、Cursor、Codex 等客户端的配置见[接入 Agent](./integrations)。

## 网站需要登录时

先按错误结果中的建议设置认证：

```bash
unicli auth setup <site>
unicli auth import <site> --browser chrome
unicli auth check <site>
```

浏览器操作使用 Uni-CLI 的 profile 和 session。详情见[登录与认证](./authentication)和[浏览器与桌面](./browser-desktop)。

## 操作失效时

错误结果可能带上源文件、失败步骤和修复命令。

```bash
unicli repair <site> <command> --dry-run
unicli repair <site> <command>
```

完整流程见[自修复](./self-repair)。

## 下一步

- [查找操作](./)
- [接入 Agent](./integrations)
- [常用场景](/zh/RECIPES)
- [操作目录](/zh/reference/sites)
