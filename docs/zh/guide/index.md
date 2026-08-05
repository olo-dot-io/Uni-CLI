---
title: 查找操作
description: 用自然语言搜索 Uni-CLI，查看命令参数，并获得结构化结果。
---

# 查找操作

直接描述想得到的结果。Uni-CLI 会搜索本地目录，并返回最匹配的命令、接口类型、操作效果和目标。

```bash
unicli search "查看 Hacker News 热门文章"
```

搜索结果会给出可以直接运行的命令：

```text
hackernews top  Hacker News top stories
unicli hackernews top
```

## 查看命令

`describe` 会列出参数、登录要求、执行接口和示例。

```bash
unicli describe hackernews top
```

需要完整操作合同时，加上 `--full`：

```bash
unicli describe hackernews top --full -f json
```

## 运行

```bash
unicli hackernews top --limit 5 -f json
```

终端和管道默认输出 Markdown。程序读取结果时可选 `json`、`yaml`、`csv` 或 `compact`。

## 缩小搜索范围

```bash
unicli search "发送消息" --effect send_message
unicli search "查看桌面应用" --surface desktop
unicli search "通过 API 读取" --operator structured-api
```

也可以在[操作目录](/zh/reference/sites)中按站点、命令或接口浏览。
