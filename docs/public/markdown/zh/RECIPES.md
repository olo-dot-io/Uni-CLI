<!-- 由 docs/zh/RECIPES.md 生成。不要直接编辑此副本。 -->

# 常用场景

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/RECIPES
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/RECIPES.md
- 栏目: 使用 Uni-CLI
- 上级: 使用 Uni-CLI (/zh/guide/)

每个示例先查找操作，最后得到程序或 Agent 可以继续读取的数据。

## 读取公开网站

先找命令：

```bash
unicli search "查看 Hacker News 热门文章"
```

查看参数，再读取五条结果：

```bash
unicli describe hackernews top
unicli hackernews top --limit 5 -f json
```

用 `jq` 选择需要的字段：

```bash
unicli hackernews top --limit 5 -f json |
  jq '.data[] | {title, url, score}'
```

## 搜索并阅读论文

搜索 arXiv：

```bash
unicli arxiv search "agent computer interfaces" --limit 5 --sort submittedDate -f json
```

选中 ID 后下载 PDF，并读取开头几页：

```bash
unicli arxiv download 1706.03762 --output ./papers -f json
unicli pdf read ./papers/1706.03762.pdf --first_page 1 --last_page 3 -f json
```

如果实际文件名与 ID 不同，用 `unicli describe arxiv download` 查看返回字段。

## 设置登录站点

先运行目标操作，error envelope 会指出缺少的认证。

```bash
unicli <site> <command> -f json
unicli auth setup <site>
unicli browser profiles --json
unicli auth import <site> --browser chrome
unicli auth check <site>
```

`auth check` 成功后，重新运行原命令。

## 操作浏览器页面

读取浏览器状态，启动 provider，再查看页面：

```bash
unicli browser doctor --json
unicli browser start
unicli browser open https://example.com
unicli browser state -f json
```

使用 `browser state` 返回的 ref：

```bash
unicli browser click <ref>
unicli browser type <ref> "搜索内容"
```

需要视觉确认时保存截图：

```bash
unicli browser screenshot ./page.png
```

## 归档 OpenReview venue

先查看参数，再启动可续传归档：

```bash
unicli describe openreview conference
unicli openreview conference <venue-group-or-url> \
  --output ./openreview-archives \
  --rpm 20
```

`--metadata-only` 会先收集投稿、评审、决定、编辑历史和文件元数据。目录结构见[归档 OpenReview conference](/zh/guide/openreview-archive)。

## 预览写操作

用 `describe` 查看 effect 和参数，`--dry-run` 会显示解析后的计划：

```bash
unicli describe <site> <command> --full -f json
unicli <site> <command> [args] --dry-run -f json
```

命中本机权限策略的命令会返回明确的批准步骤和计划参数。
