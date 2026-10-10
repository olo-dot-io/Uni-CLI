<!-- 由 docs/zh/guide/internet-access.md 生成。不要直接编辑此副本。 -->

# 互联网访问

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/internet-access
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/internet-access.md
- 栏目: 使用 Uni-CLI
- 上级: 使用 Uni-CLI (/zh/guide/)

本文于 2026-10-10 根据当前工作区、官方接口和真实公开端点核验。本地命令发现、远端来源检索和正文读取分别测量。

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

OpenRouter 把查询和分页交给服务端。公开列表与详情分别采用实测的 120 秒和 300 秒新鲜度上限，并继续受每次响应的缓存策略约束。`--fresh true` 直接读取来源。共享 GET 缓存按请求头区分凭据和内容表示，通过原子替换发布文件。写入操作始终进入实际请求路径。

核验当天，OpenRouter 搜索与详情均返回真实数据。DBLP 返回 Anubis 验证页，当前 OpenReview 凭据已过期。DBLP 会返回带恢复动作的 `challenge_required`，OpenReview 会报告凭据失败。独立行为场景分别验证成功数据、分页、取消与恢复。

## 按来源契约恢复

| 响应                          | Agent 动作                                                           |
| ----------------------------- | -------------------------------------------------------------------- |
| `challenge_required`          | 使用可用官方 API 或浏览器读取；已接入凭据的 adapter 遵循自身认证流程 |
| 认证失败                      | 运行 `unicli auth setup <site>`，更新声明的凭据                      |
| HTTP 429 或可重试的上游故障   | 遵守 `Retry-After`，取消操作会结束等待                               |
| `invalid_content`             | 核对预期 MIME 和 API 地址                                            |
| `operation_outcome_ambiguous` | 先读取资源当前状态，再决定是否重复已接受的写入                       |

共享 HTTP 实现在正文解析前识别 `cf-mitigated: challenge`。HTML 备用判断同时检查验证页标题与专有内容，普通 Turnstile 文档继续正常读取。重试支持秒数和 HTTP 日期，下一次请求前释放失败响应。读取中断沿同一尝试预算恢复，已接受写入的响应中断会返回待核对的执行结果。

[Cloudflare Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/) 要求已识别的运营方密钥和可验证的 HTTP 签名，最终访问决定由来源控制。本轮已实现内容协商、验证页分类，以及 adapter 自身的认证恢复路径。`extract`、`web read` 和 DBLP 等公开直接读取路径不会导入浏览器 cookie。浏览器验证后的 API 重试需要 adapter 明确声明并使用相应凭据。Web Bot Auth 注册和通用 CAPTCHA 解算属于尚未实现的能力。

## 按相同范围比较

[Exa](https://exa.ai/docs/reference/search) 提供托管网页搜索、正文提取、域名过滤、日期约束和结果数量控制。[Context7](https://context7.com/docs/api-guide) 提供文档搜索、库选择、版本提示和片段重排。Uni-CLI 负责本地操作发现，并组合已注册来源的执行与恢复能力。

[基准报告](/zh/BENCHMARK) 在同一操作目录上比较 BM25、TF-IDF 和 MiniSearch，另外测量原生 Markdown 与 OpenRouter 的真实响应大小。Exa 和 Context7 的托管搜索质量需要独立的共同查询集、可用凭据和相关性标注。本地排序结果只支持对应目录与测量范围内的结论。
