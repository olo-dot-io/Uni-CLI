<!-- 由 docs/zh/index.md 生成。不要直接编辑此副本。 -->

# 概览

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/index.md
- 栏目: 上手

## Agent 操作真实软件的一条命令入口

Uni-CLI 让 Agent 用同一套命令搜索并操作网站、浏览器会话、桌面应用、本地工具、文件和协议服务。

## 第一次运行

```bash
npm install -g @zenalexa/unicli
unicli search "查看 Hacker News 热门文章"
unicli describe hackernews top
unicli hackernews top --limit 5 -f json
```

## 使用方式

1. 用 `unicli search` 描述想完成的任务。
2. 用 `unicli describe` 查看参数、认证方式和输出。
3. 运行选中的命令，Agent 场景优先使用 `-f json`。
4. 命令失败时读取 stderr 中的结构化错误，再运行 `unicli repair` 检查修复路径。

## 可操作的界面

- 网站与公开 API
- 已登录浏览器会话
- 桌面应用与 macOS 能力
- 本地 CLI、文件与协议服务
- MCP 与 ACP 客户端

## 覆盖范围

- 静态 adapter 站点：338
- 已注册 adapter 操作：1891
- Built-in action：113（58 registered + 55 transport-native）
- 测试：10392

这些数字来自当前静态适配器目录。核心命令和主机动态发现的工具会在运行时加入。

## 入口

- [快速开始](/zh/guide/getting-started)：安装并完成第一条命令。
- [接入 Agent](/zh/guide/integrations)：选择 CLI、MCP 或 ACP。
- [操作目录](/zh/reference/sites)：查找当前站点与命令。
- [创建适配器](/zh/guide/adapters)：把新的软件界面接入 Uni-CLI。
- [CLI 参考](/zh/reference/cli)：查看完整命令入口。

## 当前版本

当前 latest：v1.2.1 · Artemis · Wiseman。

## Agent 索引

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
