<!-- 由 docs/zh/RECIPES.md 生成。不要直接编辑此副本。 -->

# 常用场景

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/RECIPES
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/RECIPES.md
- 栏目: 上手
- 上级: 上手 (/zh/)

这些配方覆盖最常见的使用路径。命令保持英文，因为它们就是实际 CLI 合同。

## 找一个命令并运行

```bash
unicli search "github trending"
unicli github-trending daily --limit 10
```

脚本里用 JSON：

```bash
unicli github-trending daily --limit 10 -f json
```

## 给智能体一个短合同

把这段放进项目的 agent 指令：

```markdown
Use `unicli search "intent"` before choosing a command. Run commands as
`unicli SITE COMMAND [args]`. Prefer `-f json` for scripts and structured
Markdown for human-readable output.
```

## 设置认证

```bash
unicli auth setup SITE
unicli auth check SITE
```

Cookie 文件：

```text
~/.unicli/cookies/SITE.json
```

## 修复命令

```bash
unicli SITE COMMAND
unicli repair SITE COMMAND
```

修复时看错误信封：

- `error.adapter_path`
- `error.step`
- `error.suggestion`
- `error.alternatives`

## 浏览器操作

```bash
unicli operate goto "https://example.com"
unicli operate snapshot
unicli operate click --ref 42
unicli operate type --ref 7 --text "hello"
```

适合临时探索页面，或者为 browser adapter 找 selector。

## MCP 服务

```bash
npx @zenalexa/unicli mcp serve
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
```

## ACP 网关

```bash
unicli acp
```

ACP 只是一条兼容路径。能直接跑 shell 时，优先用 `unicli` 命令。

## 列出能力

```bash
unicli list
unicli list --site macos
unicli list --category desktop
unicli search "office insert image"
```

## 论文工作流：搜索、下载、读取 PDF

```bash
unicli arxiv search "retrieval augmented generation" --limit 5 -f json > /tmp/arxiv.json
ID=$(jq -r '.[0].id' /tmp/arxiv.json)
unicli arxiv download "$ID" --output ./papers -f json
unicli pdf read "./papers/$ID.pdf" --first_page 1 --last_page 3 -f json
```

如果下载后的文件名不是 `<id>.pdf`，以 `arxiv download` JSON 输出里的实际路径为准，再传给 `pdf read`。

## ACG 角色发现：先搜意图，再落来源

```bash
unicli search "花火 星穹铁道 character" --limit 8
unicli anilist characters "Sparkle" --limit 5 -f json
unicli moegirl search "花火 星穹铁道" --limit 5 -f json
unicli danbooru tags sparkle --limit 10 -f json
```

角色名容易撞词时，把作品名、日文名、英文名、罗马音一起放进查询。booru 搜索前先跑 `tags` 或 `wiki`，确认目标站点采用的标准 tag 写法。

## Booru tag 工作流

```bash
unicli safebooru tags blue_archive --limit 5 -f json
unicli danbooru tags blue_archive --limit 5 -f json
unicli safebooru search "blue_archive rating:safe" --limit 10 -f json
unicli danbooru search "blue_archive rating:safe" --limit 10 -f json
unicli danbooru detail 123456 -f json
```

Safebooru 搜索使用 `blue_archive rating:safe` 这种 Moebooru tag 语法，不是任意日文句子搜索。遇到下划线、罗马音、别名差异时，先查 tag 再查 post。

## 美少女游戏与 2024-2026 媒体检索

```bash
unicli search "Yuzusoft visual novel games" --limit 8
unicli vndb search "Yuzusoft" --limit 10 -f json
unicli bangumi game "学園アイドルマスター" --year 2024 --sort rank -f json
unicli anilist anime "2026" --year 2026 --sort trending --limit 10 -f json
unicli moegirl search "柚子社" --limit 5 -f json
```

同一个作品在不同来源里可能是日文、罗马音、中文译名或英文名。排序和筛选以 `unicli describe <site> <command> -f json` 里的 `args_schema` 为准。

## 检查项目健康

```bash
npm run verify
npm run docs:build
```

改 adapter 后至少跑：

```bash
npm run lint:adapters
npm run lint:schema-v2
npm run test:adapter
```
