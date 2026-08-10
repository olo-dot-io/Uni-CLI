<!-- 由 docs/zh/guide/getting-started.md 生成。不要直接编辑此副本。 -->

# 快速开始

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/getting-started
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/getting-started.md
- 栏目: 上手
- 上级: 上手 (/zh/)

安装 Uni-CLI，描述想要的结果，再运行选中的操作。

## 准备工作

- Node.js 22.19 或更新版本
- npm

## 1. 安装

```bash
npm install -g @zenalexa/unicli
```

确认版本。

```bash
unicli --version
```

检查后续版本，但不执行安装。

```bash
unicli upgrade --check -f json
```

## 2. 按意图搜索

```bash
unicli search "查看 Hacker News 热门文章"
```

结果会显示匹配的命令、接口类型、操作效果和目标。每项结果还带有可直接运行的命令、查看参数的命令、认证状态，以及需要登录时的设置命令。

## 3. 从目标生成计划

Agent 需要一次取得候选操作、参数 Schema 和下一步命令时，可以使用 `do`。

```bash
unicli do "查看我收藏的小红书笔记" -f json
```

`do` 只生成计划。Agent 检查操作效果和参数以后，再执行结果中的 `next_action`。

## 4. 查看参数

```bash
unicli describe hackernews top
```

`describe` 会给出可用参数和调用示例，适合让 Agent 在执行前准备好参数。

## 5. 运行操作

```bash
unicli hackernews top --limit 5 -f json
```

成功结果使用 v2 envelope。

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

把下面这段话发给能运行 Shell 的 Agent。

```text
用 npm install -g @zenalexa/unicli 安装 Uni-CLI。
操作网站、App 或本地工具前，先运行 unicli search "<意图>" 或 unicli do "<目标>"。
用 unicli describe <site> <command> 查看参数，再用 -f json 运行。
结果出现 meta.update 时，执行其中的 unattended_command，再重试原任务。
遇到登录要求时，执行 error envelope 中的 suggestion。
```

MCP、Claude Desktop、Cursor、Codex 等客户端的配置见[接入 Agent](/zh/guide/integrations)。

## 查找个人内容

个性化操作覆盖当前登录用户的信息流、收藏、关注关系、账户和活动记录。意图中出现 `我的`、`收藏`、`关注`、`推荐`、`my` 或 `saved` 时，可以只搜索这类操作。

```bash
unicli list --personalized
unicli list --site xiaohongshu --personalized
unicli search "查看我收藏的小红书笔记" --personalized
unicli describe xiaohongshu saved
unicli xiaohongshu saved --limit 20 -f json
```

[操作目录](/zh/reference/sites)提供「个性化」和「需要认证」筛选。展开网站以后可以查看全部已注册命令。

## 网站需要登录时

先按错误结果中的建议设置认证。

```bash
unicli auth setup <site>
unicli auth import <site> --browser chrome
unicli auth check <site>
```

浏览器操作使用 Uni-CLI 的 profile 和 session。详情见[登录与认证](/zh/guide/authentication)和[浏览器与桌面](/zh/guide/browser-desktop)。

## 操作失效时

错误结果可能带上源文件、失败步骤和修复命令。

```bash
unicli repair <site> <command> --dry-run
unicli repair <site> <command>
```

完整流程见[自修复](/zh/guide/self-repair)。

## 下一步

- [查找操作](./)
- [接入 Agent](/zh/guide/integrations)
- [更新 Uni-CLI](/zh/guide/upgrading)
- [常用场景](/zh/RECIPES)
- [操作目录](/zh/reference/sites)
