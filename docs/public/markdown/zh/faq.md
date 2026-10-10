<!-- 由 docs/zh/faq.md 生成。不要直接编辑此副本。 -->

# 常见问题

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/faq
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/faq.md
- 栏目: 项目
- 上级: 项目 (/zh/ARCHITECTURE)

## Uni-CLI 是什么？

Uni-CLI 是面向 AI Agent 的开源命令运行时。Agent 可以用统一命令搜索并操作网站、浏览器会话、桌面应用、本地工具、文件和协议服务。

## 第一次应该运行什么？

```bash
npm install -g @zenalexa/unicli
unicli search "查看 Hacker News 热门文章"
unicli hackernews top --limit 5 -f json
```

[快速开始](/zh/guide/getting-started)会解释每一步。

## 哪些 Agent 可以使用？

能启动进程的 Agent 都可以使用 CLI。需要协议连接的客户端可以使用 MCP 或 ACP 服务。配置见[接入 Agent](/zh/guide/integrations)。

## 目录中有什么？

v1.3.0 的静态 adapter 目录包含 <span><!-- STATS:site_count -->338<!-- /STATS --></span> 个站点。

同一目录包含 <span><!-- STATS:command_count -->1893<!-- /STATS --></span> 条注册命令。Core command 与主机发现的工具会在运行时加入。可以浏览[操作目录](/zh/reference/sites)，也可以运行 `unicli list`。

## 如何查看命令参数？

运行。

```bash
unicli describe <site> <command>
```

`--full` 提供操作效果、交互、批准、评估和修复的详细契约。

## 登录如何工作？

每条操作声明自己的连接策略。`unicli auth setup <site>` 显示需要的凭据。通过 `unicli browser profiles --json` 选择浏览器身份后，支持 cookie 的命令可直接复用登录态，`unicli auth import` 用于显式保存。详情见[登录与认证](/zh/guide/authentication)。

## 输出在哪里？

成功数据写入 stdout，结构化错误写入 stderr，并设置对应退出码。终端默认输出 Markdown，也可以用 `-f json`、`yaml`、`csv` 或 `compact`。

## 网站变化后怎么办？

适配器错误可以包含源文件、失败步骤和修复建议。更新对应适配器，用 `unicli repair <site> <command> --dry-run` 预览，再运行验证。详情见[自修复](/zh/guide/self-repair)。

## 可以添加站点吗？

可以。`unicli init <site> <command>` 创建 YAML 适配器，`unicli dev <path>` 在开发时重新加载。先阅读[创建适配器](/zh/guide/adapters)。

## CLI 还是 MCP？

Agent 主机能启动进程，并需要管道、文件及完整命令时，使用 CLI。客户端通过 MCP 服务管理工具时，使用 MCP。两者读取同一操作目录。

## Uni-CLI 免费吗？

是。项目使用 Apache-2.0 许可证，CLI 发布为 [`@zenalexa/unicli`](https://www.npmjs.com/package/@zenalexa/unicli)。
