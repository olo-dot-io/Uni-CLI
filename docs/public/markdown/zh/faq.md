<!-- 由 docs/zh/faq.md 生成。不要直接编辑此副本。 -->

# 常见问题

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/faq
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/faq.md
- 栏目: 项目
- 上级: 项目 (/zh/ARCHITECTURE)

## Uni-CLI 是什么？

Uni-CLI 是面向 AI Agent 的开源命令运行时。Agent 可以用统一命令模型搜索并操作网站、浏览器 session、桌面 App、本地工具、文件和协议服务。

## 第一次应该运行什么？

```bash
npm install -g @zenalexa/unicli
unicli search "查看 Hacker News 热门文章"
unicli hackernews top --limit 5 -f json
```

[快速开始](/zh/guide/getting-started)会解释每一步。

## 哪些 Agent 可以使用？

能启动进程的 Agent 都可以使用 CLI。需要协议连接的客户端可以使用 MCP 或 ACP server。配置见[接入 Agent](/zh/guide/integrations)。

## 目录中有什么？

v1.0.3 的静态 adapter 目录包含 <span><!-- STATS:site_count -->326<!-- /STATS --></span> 个站点。

同一目录包含 <span><!-- STATS:command_count -->1853<!-- /STATS --></span> 条注册命令。Core command 与主机发现的工具会在运行时加入。可以浏览[操作目录](/zh/reference/sites)，也可以运行 `unicli list`。

## 如何查看命令参数？

运行：

```bash
unicli describe <site> <command>
```

`--full` 会加入 effect、interaction、approval、evaluation 和 repair 的详细合同。

## 登录如何工作？

每条操作会声明 public、cookie、header、intercept 或 UI strategy。`unicli auth setup <site>` 会显示需要的凭据。`unicli browser profiles --json` 与 `unicli auth import` 可以复用本机浏览器登录态。详情见[登录与认证](/zh/guide/authentication)。

## 输出在哪里？

成功数据写入 stdout，结构化错误写入 stderr，并设置对应退出码。终端默认输出 Markdown，也可以用 `-f json`、`yaml`、`csv` 或 `compact`。

## 网站变化后怎么办？

Adapter error 可以包含源文件、失败步骤和建议的修复命令。更新对应 adapter，用 `unicli repair <site> <command> --dry-run` 预览，再运行 verifier。详情见[自修复](/zh/guide/self-repair)。

## 可以添加站点吗？

可以。`unicli init <site> <command>` 会创建 YAML adapter，`unicli dev <path>` 在开发时重新加载。先阅读[创建适配器](/zh/guide/adapters)。

## CLI 还是 MCP？

Agent 主机能启动进程，并需要管道、文件与完整命令覆盖时，使用 CLI。客户端通过 MCP server 管理工具时，使用 MCP。两者读取同一操作目录。

## Uni-CLI 免费吗？

是。项目使用 Apache-2.0 许可证，CLI 发布为 [`@zenalexa/unicli`](https://www.npmjs.com/package/@zenalexa/unicli)。
