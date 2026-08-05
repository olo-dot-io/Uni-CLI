---
title: 术语表
description: 用直白语言解释 Uni-CLI 命令和 adapter 文档中的常用术语。
---

# 术语表

## Adapter

为站点、应用、服务或工具注册操作的文件或模块。大多数 packaged adapter 使用 YAML，需要自定义控制流的集成使用 TypeScript。

## AgentEnvelope

Uni-CLI 命令共享的 v2 结果结构。`ok` 表示结果，`data` 承载成功数据，`error` 承载结构化失败，`meta` 描述本次调用。

## Browser Runtime Broker

管理 browser provider、profile、session、target 和 lease 的本地服务。

## Catalog

已安装的操作集合。Packaged adapter 构成静态目录；core command、user adapter、plugin 和主机发现的 CLI 可在运行时加入。

## Command contract

`unicli describe` 返回的机器可读说明，包含参数、认证、effect、operator、目标、示例和 repair metadata。

## Effect

操作可能产生的变化类型，例如 `read`、`download_file`、`send_message`、`local_file` 和 `destructive`。搜索和本机权限策略都可以按 effect 过滤。

## Error envelope

失败 AgentEnvelope 中的 `error` 对象。它包含稳定的 code 与 message，也可能提供 suggestion、remedy command、retry 状态、源文件或失败步骤。

## Execution operator

真正执行操作的接口，包括 `structured-api`、`browser-protocol`、`native-cli`、`browser-semantic`、`desktop-accessibility`、`visual-observation`、`visual-coordinate` 和 `local-runtime`。

## MCP

Model Context Protocol。`unicli mcp serve` 可以把 Uni-CLI 接入使用 MCP 管理工具的客户端。

## Operation

带有参数、目标、effect、operator 和结果结构的可搜索命令。Shell 形式为 `unicli <site> <command>`。

## Pipeline

YAML adapter 中按顺序执行的 action。Pipeline 可以请求、转换、导航、交互、下载或控制执行流程。

## Profile

保存 cookie、local storage 和其他登录态的浏览器存储分区。`unicli browser profiles --json` 会列出本机可用的 Chromium profile。

## Repair

Adapter 更新后的验证步骤。`unicli repair <site> <command>` 会重新运行目标操作，并检查 envelope 与进程状态。

## Site

命令前的 namespace，例如 `unicli hackernews top` 中的 `hackernews`。Site 可以表示网站、App、服务、文件类型、操作系统 surface 或外部 CLI。

## Strategy

Web adapter 声明的连接方式：`public`、`cookie`、`header`、`intercept` 或 `ui`。

## User adapter

保存在 `~/.unicli/adapters/` 下的 adapter。它用于本地扩展，也可以覆盖相同 site 和 command 的 packaged entry。

## YAML adapter

包含 metadata、参数和 pipeline steps 的声明式 adapter。`unicli init` 创建文件，`unicli dev` 在开发时重新加载。
