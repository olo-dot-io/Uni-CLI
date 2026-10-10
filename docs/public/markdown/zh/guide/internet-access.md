<!-- 由 docs/zh/guide/internet-access.md 生成。不要直接编辑此副本。 -->

# 互联网访问

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/internet-access
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/internet-access.md
- 栏目: 使用 Uni-CLI
- 上级: 使用 Uni-CLI (/zh/guide/)

使用 Uni-CLI 查找来源、搜索记录，再读取任务所需的正文。先从本地命令目录选出操作，再调用来源的检索接口，最后获取 Agent 可以直接处理的内容。每一步的结果都提供下一次调用所需的信息。

## 找到来源并执行

`search` 在本地操作目录中排序，站点命令负责网络请求。任务需要特定来源的数据时，直接指定来源。

```bash
unicli search "搜索 DBLP 图数据库论文" -f json
unicli describe dblp search --full -f json
unicli dblp search "graph databases" --limit 10 --offset 0 -f json
unicli retrieval search "graph databases" --sources dblp,arxiv --limit 10 -f json
```

命令排序结合双语词法检索、站点与操作精确匹配，以及任务相关加分。明确指定学术来源并搜索论文主题的查询保留对应站点入口。寻找论文代码、审稿和数据的请求继续使用对应资源工作流。跨来源检索按规范 URL 合并结果，同一来源的重复记录只贡献一次最佳排名。按时间排序时，先完成排序，再截取最终结果。

## 优先读取 Agent 表示

```bash
unicli extract https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/ --max-chars 12000 -f json
unicli web read https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/ -f json
unicli extract https://example.com --as html -f json
```

Markdown 读取优先发送 `Accept: text/markdown`。原生 Markdown 保留原文，HTML 使用现有正文转换器。显式 HTML 读取继续请求 HTML。[Cloudflare 原生 Markdown](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/) 通过普通 HTTP 内容协商提供这种能力。

`extract` 返回请求 URL、最终 URL、获取时间、内容类型、标题、链接和截断信息。直接文本读取限制为 500 万字节和 30 秒。`web read` 保留字符串结果，正文超过 100 万字符时返回 `response_too_large`。需要控制上下文大小时，使用 `extract --max-chars` 获取带明确边界的证据记录。

## 保存一组研究资料

任务需要本地文件时，使用 `retrieval acquire`。输入查询词时，命令复用 `retrieval search` 的来源选择和排序；输入明确的 HTTP(S) URL 时，直接从该地址获取资料。

```bash
unicli retrieval acquire "graph databases" \
  --sources dblp,arxiv \
  --limit 5 \
  --max-resources 10 \
  --dir ./research/graph-databases \
  -f json

unicli retrieval acquire \
  https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/ \
  --max-resources 0 \
  --dir ./research/cloudflare \
  -f json
```

命令先流式保存每个选中 URL 的原件，再根据响应 MIME 处理已经下载的文本，生成相邻的 `<id>.document.json`。PDF、压缩包、图片等二进制响应保留原始字节，URL 没有扩展名时同样可以保存。超过 500 万字节结构化上限的文本只保存原件。

对于选中的结果页，命令收集文件名或链接文字表明可下载的资源，完成去重和查询相关性排序后，只下载一层受限链接。额外下载的文件是终点，其内部链接不会继续触发抓取。

### 控制资料数量

`--limit` 控制选中的搜索结果，`--max-resources` 单独控制从这些页面发现的额外文件链接。直接输入 URL 时，初始资源只有这一项。设置 `--max-resources 0` 可以只保存选中的 URL。

| 参数              | 默认值        | 取值与含义                                   |
| ----------------- | ------------- | -------------------------------------------- |
| `--limit`         | `20`          | 选中 1 至 100 条搜索结果                     |
| `--max-resources` | `20`          | 所有结果页合计额外下载 0 至 100 个文件链接   |
| `--concurrency`   | `3`           | 同时下载 1 至 8 个资源                       |
| `--max-bytes`     | `52428800`    | 单个原件为 1 字节至 1 GiB，默认 50 MiB       |
| `--timeout-ms`    | `30000`       | 单个资源下载期限为 1 至 300000 毫秒          |
| `--dir`           | `./downloads` | 原件、结构化文档和 `results.json` 的保存目录 |
| `--refresh`       | `false`       | 传入 `true` 后重新获取已完成的资源           |

查询还接受 `--sources`、`--kind`、`--source-class`、`--repository`、`--since` 和 `--sort`。完整契约见 `unicli describe retrieval acquire --full -f json`。来源搜索和文件下载分别使用各自的期限。

### 检查保存结果

JSON 响应的 `data[0]` 包含资料获取结果，`data[0].manifest_path` 是结果文件的绝对路径。`results.json` 直接保存这个资料获取对象，并在资源完成时更新。

- `candidates` 保留选中的搜索记录及其来源。
- `resources` 记录每个 URL、发现它的 `source_urls`、本地 `path`、字节数 `size` 和 `status`。
- `document_path` 指向已生成的结构化文档。转换失败时，`structure_error` 说明原因，原件继续保留。
- `source_errors` 单独记录搜索来源的失败，与文件下载结果分开。
- `linked_resources_found` 和 `linked_resources_selected` 说明额外资源上限对选择的影响，`selection_complete` 表示选择是否完成。原结果页失败且仍有额外资源名额时，该值保持 `false`，恢复后继续从该页补足剩余名额。已经选中的额外资源仍然是抓取终点。

逐项检查资源状态。`success` 表示新原件已经发布到目标路径，`skipped` 表示复用了完整原件，`failed` 附带错误和重试命令。取消后，命令等待活跃下载结束，将未完成项记为 `cancelled`，并保留已经完成的文件。

### 恢复同一组资料

使用结果返回的绝对 `manifest_path` 恢复，省去重新搜索来源。每次调用只提供查询或 `--resume` 其中一种。

```bash
unicli retrieval acquire \
  --resume ./research/graph-databases/results.json \
  -f json

unicli retrieval acquire \
  --resume ./research/graph-databases/results.json \
  --refresh true \
  -f json
```

恢复会重建保存的资源选择。原件复用要求记录中的 URL、路径、成功状态和字节数都与本地文件匹配。失败、缺失或尺寸变化的文件会重新下载。已记录的文本结构化失败也会在恢复时触发重新下载。这项复用检查比较文件元数据，需要获取来源的最新字节时使用 `--refresh true`。

每行的 `retry_command` 使用原下载大小和超时上限恢复整组资料，因此一次调用可以恢复多个失败项。恢复文件所在目录决定输出位置。移动资料时，把文件和 `results.json` 一起复制到新目录。目录变化会产生新的绝对路径，恢复时会将资源重新获取到该目录。损坏或格式不兼容的恢复文件会返回 `invalid_input`，原文件保持不变。

下载使用下文相同的匿名优先、按域名获取凭据的恢复流程。`--no-auth-retry` 关闭这些请求的自动凭据恢复。认证或验证仍未通过时，该资源保留失败记录，调用方可以继续使用已完成文件，并根据来源错误决定下一步。

## 学术与模型来源

| 来源       | 当前请求路径                        | 分页与身份                                           |
| ---------- | ----------------------------------- | ---------------------------------------------------- |
| DBLP       | 官方搜索 API 与作者 XML             | `--offset`、来源总数、作者 PID、按年份排序的作者论文 |
| OpenReview | 使用 `source=papers` 的官方论文搜索 | `--offset`、v1/v2 内容字段、作者 profile ID          |
| OpenRouter | 原生模型搜索与单模型详情            | `--limit`、`--offset`、`--sort`、规范模型 slug       |

```bash
unicli dblp author "Yann LeCun" --limit 10 --offset 0 -f json
unicli openreview search "diffusion" --limit 10 --offset 0 -f json
unicli openrouter search "gpt-5" --limit 2 --sort newest -f json
unicli openrouter model openai/gpt-5.6-luna -f json
unicli openrouter search "gpt-5" --limit 2 --fresh true -f json
```

OpenRouter 把查询和分页交给服务端。公开列表与详情分别采用 120 秒和 300 秒新鲜度上限，并继续受每次响应的缓存策略约束。`--fresh true` 直接读取来源。共享 GET 缓存按请求头区分凭据和内容表示，通过原子替换发布文件。写入操作始终进入实际请求路径。

`dblp search` 遇到 Anubis 验证页时，stderr 保留 `error.code = challenge_required`。执行 `error.alternatives[0]` 中的完整命令，可以查询 [DBLP 官方 SPARQL 服务](https://blog.dblp.org/2024/09/09/introducing-our-public-sparql-query-service/)。该替代入口按输入的字面短语匹配论文标题，忽略大小写，按年份降序和记录 URI 升序排列，并保留原 limit 与 offset。它使用独立的匹配语义，由调用方显式选择执行。`extract` 返回的记录位于 `data.structured_data.results.bindings`。将同一 URL 交给 `retrieval acquire`，可以保存来源 JSON 和结构化文档。

OpenReview 凭据过期时会返回认证失败。按来源的说明恢复后，保留原查询和分页参数再次执行。

## 按来源契约恢复

| 响应                          | Agent 动作                                                           |
| ----------------------------- | -------------------------------------------------------------------- |
| `challenge_required`          | 使用可用官方 API 或浏览器读取；已接入凭据的 adapter 遵循自身认证流程 |
| 认证失败                      | 运行 `unicli auth setup <site>`，更新声明的凭据                      |
| HTTP 429 或可重试的上游故障   | 遵守 `Retry-After`，取消操作会结束等待                               |
| `invalid_content`             | 核对预期 MIME 和 API 地址                                            |
| `operation_outcome_ambiguous` | 先读取资源当前状态，再决定是否重复已接受的写入                       |

HTTP 读取在正文解析前识别 `cf-mitigated: challenge`，并通过标题与专有内容识别 HTML 验证页，普通 Turnstile 文档可正常读取。重试等待支持秒数和 HTTP 日期，下一次请求前会释放失败响应。读取中断使用剩余尝试次数。写入已被接受、响应随后中断时，先检查资源状态，再决定是否重复写入。

`extract` 和 `web read` 先匿名请求。遇到 401、403 或验证页时，读取器可以使用目标域名已保存的 cookie 重试，再尝试选定浏览器配置中的新 cookie，认证尝试最多分为这三个阶段。显式第三方读取器不会收到来源站点的 cookie。声明 cookie 认证的 HTTP 只读适配器使用执行运行时的一次刷新重试。浏览器操作通过新回合恢复。`--no-auth-retry` 同时关闭 HTTP 适配器和直接 URL 读取的自动凭据恢复。配置选择、显式导入和 `--no-auth-retry` 用法见[登录与认证](/zh/guide/authentication)。

[Cloudflare Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/) 要求已识别的运营方密钥和可验证的 HTTP 签名，最终访问决定由来源控制。验证仍未通过时，按来源支持的 API 或浏览器认证流程继续。Web Bot Auth 注册和通用 CAPTCHA 解算属于尚未实现的能力。

## 按相同范围比较

[Exa](https://exa.ai/docs/reference/search) 提供托管网页搜索、正文提取、域名过滤、日期约束和结果数量控制。[Context7](https://context7.com/docs/api-guide) 提供文档搜索、库选择、版本提示和片段重排。Uni-CLI 负责本地操作发现，并组合已注册来源的执行与恢复能力。

[基准报告](/zh/BENCHMARK) 在同一操作目录上比较 BM25、TF-IDF 和 MiniSearch，另外测量原生 Markdown 与 OpenRouter 的真实响应大小。Exa 和 Context7 的托管搜索质量需要独立的共同查询集、可用凭据和相关性标注。本地排序结果只支持对应目录与测量范围内的结论。
