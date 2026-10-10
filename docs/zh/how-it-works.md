---
title: Uni-CLI 的工作方式
description: 从意图搜索开始，了解执行、结构化结果、修复和验证式进化的完整流程。
---

# Uni-CLI 的工作方式

Uni-CLI 为网站、浏览器、桌面应用、本地工具、文件和协议服务提供统一命令模型。每次调用先查找操作并查看契约，通过声明的接口执行，最后返回结构化结果。

## 1. 在本地查找操作

```bash
unicli search "查看 Hacker News 热门文章"
```

搜索在已安装的命令目录中完成。运行时只编译一次任务，识别准确名称及带有拼写误差的提供方名称，再对中英文命令描述排序。检索时按操作效果、执行接口、目标范围、分类和平台过滤不兼容命令。结果包含具名排序信号，便于理解选择依据。命令发现过程只读取本地目录。

## 2. 操作会说明自己的参数

```bash
unicli describe hackernews top
```

操作契约包含以下字段。

- 参数和默认值
- 登录要求
- 目标范围与执行接口
- 操作效果与交互影响
- 适配器源文件和修复入口

Agent 可以在打开浏览器、启动桌面驱动或访问服务前准备好参数。

## 3. 通过声明的接口执行

操作可以通过结构化 API、浏览器协议、原生 CLI、网页元素、桌面无障碍接口、视觉控制或本地运行时执行。目录通过 `operator` 和 `minimum_capability` 记录所用接口及最低能力要求。

```bash
unicli hackernews top --limit 5 -f json
```

参数可以来自 Shell 选项、标准输入中的 JSON 或参数文件。运行时先验证参数，再连接目标接口。

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

适配器错误可以指出源文件和失败步骤。更新适配器后，运行 `repair` 重新执行原命令，验证修复结果。

```bash
unicli repair <site> <command> --dry-run
unicli repair <site> <command>
```

本地开发时，`~/.unicli/adapters/` 中的用户适配器可以覆盖包内适配器。

## 同类失败重复发生时

演进会话把选定的失败记录整理成私有证据包，并使用隔离的 YAML 候选实现。Uni-CLI 通过公开 CLI 分别执行基线和候选实现，分开保存验证用例与保留测试用例，并记录每次接受或拒绝的尝试。

```bash
unicli evolve adapter <site> <command> \
  --run <proposal-run> \
  --candidate <candidate.yaml> \
  --validation <validation-eval.yaml> \
  --held-out <held-out-eval.yaml> \
  --promote
```

候选实现晋级需要验证结果严格提升，并保持保留测试的表现。安装后的覆盖版本保留完整回滚文件。Agent 提出修改，Uni-CLI 负责执行验证并判断是否晋级。

## CLI、MCP 与 ACP

CLI 提供完整命令，适合能启动进程的 Agent，以及管道、文件和 CI 工作流。MCP 面向使用工具服务的客户端，ACP 提供 Agent Client Protocol 服务。三种入口使用同一操作目录。

## 继续阅读

- [快速开始](/zh/guide/getting-started)
- [查找操作](/zh/guide/)
- [登录与认证](/zh/guide/authentication)
- [修复与进化](/zh/guide/self-repair)
- [架构](/zh/ARCHITECTURE)
