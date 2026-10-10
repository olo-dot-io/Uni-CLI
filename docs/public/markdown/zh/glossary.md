<!-- 由 docs/zh/glossary.md 生成。不要直接编辑此副本。 -->

# 术语表

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/glossary
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/glossary.md
- 栏目: 参考
- 上级: 参考 (/zh/reference/)

## Adapter

为站点、应用、服务或工具注册操作的文件或模块。大多数包内适配器使用 YAML，需要自定义控制流的集成使用 TypeScript。

## AgentEnvelope

Uni-CLI 命令共享的 v2 结果结构。`ok` 表示结果，`data` 承载成功数据，`error` 承载结构化失败，`meta` 描述本次调用。

## Browser Runtime Broker

管理浏览器提供方、配置、会话、目标和租约的本地服务。

## Catalog

已安装的操作集合。包内适配器构成静态目录，核心命令、用户适配器、插件和本机发现的 CLI 可在运行时加入。

## Command contract

`unicli describe` 返回的机器可读说明，包含参数、认证、操作效果、执行接口、目标、示例和修复元数据。

## Effect

操作可能产生的变化类型，例如 `read`、`download_file`、`send_message`、`local_file` 和 `destructive`。搜索和本机权限策略都可以按操作效果过滤。

## Error envelope

失败 AgentEnvelope 中的 `error` 对象，包含稳定的错误码和消息，也可能提供恢复建议、修复命令、重试状态、源文件或失败步骤。

## Execution operator

真正执行操作的接口，包括 `structured-api`、`browser-protocol`、`native-cli`、`browser-semantic`、`desktop-accessibility`、`visual-observation`、`visual-coordinate` 和 `local-runtime`。

## MCP

Model Context Protocol。`unicli mcp serve` 可以把 Uni-CLI 接入使用 MCP 管理工具的客户端。

## Operation

带有参数、目标、操作效果、执行接口和结果结构的可搜索命令。Shell 形式为 `unicli <site> <command>`。

## Pipeline

YAML 适配器中按顺序执行的动作。流水线可以请求数据、转换内容、导航、交互、下载或控制执行流程。

## Profile

保存 cookie、本地存储和其他登录态的浏览器存储分区。`unicli browser profiles --json` 列出本机可用的 Chromium 配置。

## Repair

适配器更新后的验证步骤。`unicli repair <site> <command>` 重新运行目标操作，检查响应结构和进程状态。

## Site

命令前的命名空间，例如 `unicli hackernews top` 中的 `hackernews`。站点可以表示网站、应用、服务、文件类型、操作系统接口或外部 CLI。

## Strategy

Web 适配器声明的连接方式，包括 `public`、`cookie`、`header`、`intercept` 和 `ui`。

## User adapter

保存在 `~/.unicli/adapters/` 下的适配器，用于本地扩展，也可覆盖站点和命令名称相同的包内版本。

## YAML adapter

包含元数据、参数和流水线步骤的声明式适配器。`unicli init` 创建文件，`unicli dev` 在开发时重新加载。
