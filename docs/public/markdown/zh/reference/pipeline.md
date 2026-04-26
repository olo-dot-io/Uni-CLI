<!-- 由 docs/zh/reference/pipeline.md 生成。不要直接编辑此副本。 -->

# 管线步骤

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/reference/pipeline
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/reference/pipeline.md
- 栏目: 参考
- 上级: 参考 (/zh/reference/)

Pipeline step 是 adapter 的执行积木。YAML adapter 通过一串步骤完成请求、解析、筛选、映射、浏览器操作、本地命令和断言。

字段名不要翻译：`fetch`、`select`、`map`、`exec` 等都是实际 schema 名称。中文解释只说明怎么用。

## 基本形状

```yaml
pipeline:
  - fetch:
      url: "https://api.example.com/items"
  - select: data.items
  - map:
      title: "${{ item.title }}"
      url: "${{ item.url }}"
  - limit: 20
```

每一步接收上一步输出，返回下一步输入。

## API steps

| Step         | 用途                    |
| ------------ | ----------------------- |
| `fetch`      | 请求 JSON API。         |
| `fetch_text` | 请求文本或 HTML。       |
| `parse_rss`  | 解析 RSS/Atom。         |
| `html_to_md` | 把 HTML 转成 Markdown。 |
| `websocket`  | 连接 WebSocket 服务。   |

`fetch` 示例：

```yaml
- fetch:
    url: "https://api.example.com/search"
    params:
      q: "${{ args.query }}"
      limit: "${{ args.limit }}"
```

## Transform steps

| Step     | 用途                       |
| -------- | -------------------------- |
| `select` | 用 JSONPath 或路径取子树。 |
| `map`    | 把 item 映射成稳定输出。   |
| `filter` | 过滤列表。                 |
| `sort`   | 排序。                     |
| `limit`  | 限制数量。                 |
| `set`    | 设置临时字段。             |

`map` 示例：

```yaml
- map:
    title: "${{ item.title }}"
    author: "${{ item.by }}"
    url: "${{ item.url }}"
```

## Control steps

| Step         | 用途                                |
| ------------ | ----------------------------------- |
| `if`         | 条件分支。                          |
| `each`       | 遍历列表，并可并发执行子 pipeline。 |
| `parallel`   | 并行执行多个分支。                  |
| `retry`      | 对易失败步骤重试。                  |
| `rate_limit` | 控制请求节奏。                      |
| `assert`     | 明确校验输出。                      |
| `append`     | 追加结果。                          |

并发抓详情页：

```yaml
- each:
    parallel: 10
    pipeline:
      - fetch:
          url: "https://api.example.com/item/${{ item.id }}"
```

## Browser steps

| Step         | 用途                            |
| ------------ | ------------------------------- |
| `navigate`   | 打开页面。                      |
| `wait`       | 等待 selector、时间或页面状态。 |
| `click`      | 点击元素。                      |
| `type`       | 输入文本。                      |
| `press`      | 发送按键。                      |
| `scroll`     | 滚动页面。                      |
| `snapshot`   | 读取页面结构或可交互元素。      |
| `extract`    | 从 DOM 抽取内容。               |
| `intercept`  | 捕获网络请求。                  |
| `screenshot` | 截图。                          |

浏览器步骤适合没有稳定 API 的页面：

```yaml
- navigate:
    url: "https://example.com"
    waitUntil: networkidle
- wait: "#search"
- type:
    selector: "#search"
    text: "${{ args.query }}"
- press: Enter
- snapshot: { interactive: false }
```

## Desktop / subprocess steps

| Step         | 用途                           |
| ------------ | ------------------------------ |
| `exec`       | 运行本地命令。                 |
| `write_temp` | 写临时文件，常用于脚本型工具。 |
| `download`   | 下载文件。                     |

示例：

```yaml
- exec:
    command: "ffprobe"
    args: ["-v", "quiet", "-print_format", "json", "${{ args.file }}"]
    parse: json
```

## 变量

常见变量：

| 变量                 | 含义               |
| -------------------- | ------------------ |
| `${{ args.name }}`   | 命令参数。         |
| `${{ item.field }}`  | 当前 item 的字段。 |
| `${{ env.NAME }}`    | 环境变量。         |
| `${{ step.output }}` | 前面步骤的输出。   |

变量是模板语法，不要在中文文档里改写。

## 断言

`assert` 用来防止“看似成功”的坏输出。

```yaml
- assert:
    path: data.items
    minLength: 1
    message: "Expected at least one item"
```

如果页面或 API 变了，断言能把问题变成结构化错误，方便智能体修复。

## 设计建议

- 能用 `web-api` 就不要先上浏览器。
- 能用 YAML 就不要先写 TypeScript。
- 每一步只做一件事。
- 失败时让错误指向具体 step。
- 输出字段保持稳定，字段名不要随意改。

完整字段仍以 schema 和 adapter lint 为准：

```bash
npm run lint:schema-v2
npm run lint:adapters
```
