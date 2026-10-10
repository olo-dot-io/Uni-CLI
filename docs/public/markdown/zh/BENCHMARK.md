<!-- 由 docs/zh/BENCHMARK.md 生成。不要直接编辑此副本。 -->

# 基准

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/BENCHMARK
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/BENCHMARK.md
- 栏目: 项目
- 上级: 项目 (/zh/ARCHITECTURE)

基准套件测量 Agent 直接遇到的冷启动、完整目录大小和代表性操作响应大小。

## 运行

```bash
npm run bench
```

CI 使用固定 fixture。

```bash
BENCH_FIXTURES_ONLY=1 npm run bench
```

每个根 CLI 测量都启动新进程。适配器固定样本的耗时只覆盖进程内解析与格式化，实时模式还包含命令使用的子进程和网络请求。

## 当前目录

- <span><!-- STATS:site_count -->338<!-- /STATS --></span> 个静态 adapter site
- <span><!-- STATS:command_count -->1893<!-- /STATS --></span> 条注册 adapter command
- <span><!-- STATS:adapter_count_yaml -->1006<!-- /STATS --></span> 个 schema-v2 YAML adapter
- <span><!-- STATS:pipeline_step_count -->113<!-- /STATS --></span> 个 built-in action
- <span><!-- STATS:test_count -->10374<!-- /STATS --></span> 个 test

完整 p50、p95、运行环境和生成时间见[英文报告](/BENCHMARK)。

## 如何阅读

- `unicli --help` 与 `unicli --version` 测量最小进程启动路径。
- `unicli list -f json` 测量目录载入与序列化。
- 适配器样本使用 `--limit 5`，对应常见 Agent 检索调用。
- 日常发现使用 `search` 和 `describe`，完整目录在明确请求时输出。

常见列表操作的公开目标是在 `--limit 5` 时保持总计 600 token 或更少。结果较大的命令应提供数量限制、分页或紧凑输出。

## 本地排序与强基线

本次测量日期为 2026-10-10，使用 Apple M4 Pro 和 Node 26.11.1。所有方法共用 2,014 条内置与核心命令文档，其中 2,011 条可发现。主机动态目录和用户覆盖配置统一关闭。旧版本对照使用完整的 `a3ccd598` 源码。

```bash
npm run build
BENCH_RUNS=5 BENCH_COLD_RUNS=9 npm run bench:search
```

历史数据包含 617 条正例和 26 条负例。另有 32 条任务查询，覆盖学术来源、模型查找、主题边界和明确指定来源，并附 4 条无匹配查询。32 条任务查询用于定位和修复排序问题，属于诊断集。修复后的分数反映这组场景，未知查询的表现需要单独保留的测试集验证。

| 方法                       | 历史 Top-1 | Top-3   | Top-5   | MRR@5  | 诊断 Top-1 | 常驻 p50 ms | 常驻 p95 ms |
| -------------------------- | ---------- | ------- | ------- | ------ | ---------- | ----------- | ----------- |
| 旧版 Uni-CLI `a3ccd598`    | 482/617    | 556/617 | 577/617 | 0.8444 | 20/32      | 0.057       | 0.228       |
| 当前 Uni-CLI               | 482/617    | 556/617 | 577/617 | 0.8444 | 26/32      | 0.052       | 0.191       |
| BM25                       | 443/617    | 533/617 | 560/617 | 0.7913 | 19/32      | 0.020       | 0.083       |
| TF-IDF cosine              | 454/617    | 544/617 | 566/617 | 0.8129 | 16/32      | 0.018       | 0.080       |
| MiniSearch 7.2.0 BM25+     | 429/617    | 512/617 | 553/617 | 0.7678 | 15/32      | 0.043       | 0.172       |
| MiniSearch BM25+ fuzzy 0.2 | 409/617    | 521/617 | 559/617 | 0.7581 | 13/32      | 0.153       | 0.456       |

各方法交错执行，每个方法测量 3,395 次查询。完整路由包含查询分析、意图判断、评分、前五项选择和结果整理。词法基线共用冻结的双语分词和别名扩展。BM25 使用 `k1=1.2, b=0.75`，MiniSearch 使用当前版本的 BM25+ 默认参数，分别测量精确匹配和官方文档中的模糊匹配配置。比较期间参数保持固定。

当前路由保留历史结果，修复诊断集中的 6 个来源与主题混淆问题。诊断集仍有 6 项未排首位，其中 1 项未进入前五。完整失败记录和负例原始分数保存在 `bench/search-baselines.results.json`。不同方法的分数尺度各自独立。纯词法检索的单次耗时更低，完整路由在这两组查询中的首位准确率更高。

### 独立冷启动范围

两个完整路由分别启动 9 个新进程，包含 ESM 导入、索引构建和首条查询。旧版与当前版的进程耗时中位数分别为 83.823 ms 和 82.790 ms，就绪时间中位数分别为 50.160 ms 和 48.659 ms。这里省略 CLI 参数解析与主机目录发现，完整 CLI 冷启动使用英文报告中的独立数据。报告内的单次进程内构建采样仅记录观测，构建比较使用重复冷进程样本。

## 常驻证据相关性评分

`npm run bench:relevance` 将证据评分器与固定的 `9634121c` 源码比较。在 Apple M4 Pro、darwin-arm64 和 Node 26.11.1 上，测量交替运行 9 轮，每批调用 10,000 次 `scoreRetrievalAlternatives`。基线每批中位耗时为 31.5234 ms，当前实现为 18.4456 ms，两者比值为 1.709 倍。

```bash
npm run bench:relevance
```

固定负载由 20 条查询与 500 条构造记录组成，包含多语言文本、标点、备选查询、空输入和重叠词。完整返回结果比较覆盖 `requireAllTerms` 的两种取值，20,000 次比较全部一致。交替测量前，每个实现分别预热一批。

计时覆盖字段规范化、词项匹配、评分和备选选择，查询分析提前完成一次。进程启动、模块载入、网络请求和文件 I/O 排除在此计时范围外。结果反映评分器在固定负载上的行为与成本，完整来源检索还包含独立的网络和资料获取成本。原始样本及环境信息保存在 `bench/retrieval-relevance.results.json`。

## 真实内容表示与站点请求

2026-10-10 运行 `npm run bench:internet`。字节数表示解码后的 UTF-8 正文。网络压缩、连接建立、来源缓存与远端负载分别影响实际请求成本。

| 来源与请求                             | 原路径正文字节   | 原生路径正文字节 | 减少比例 | 样本                    |
| -------------------------------------- | ---------------- | ---------------- | -------- | ----------------------- |
| Cloudflare Markdown-for-agents 文档    | 175,685 HTML     | 16,408 Markdown  | 90.66%   | 每种表示 3 次，交错执行 |
| OpenRouter `gpt-5` 模型查询，限制 2 条 | 765,940 完整目录 | 3,349 原生查询   | 99.56%   | 每条路径 1 次           |

Cloudflare 请求加正文转换的中位耗时为 HTML 219.557 ms、原生 Markdown 193.453 ms。首个 HTML 请求与转换样本耗时 6,768.108 ms，原始报告保留该样本。原生 Markdown 包含来源元数据，其内容格式与本地 HTML 提取存在差异。

OpenRouter 完整目录返回 458 条，原生查询返回 2 条，两条路径在本次运行中选出相同的模型 ID。记录的请求耗时为 7,111.872 ms 和 165.383 ms。每条路径的一次样本支持当前正文大小比较，一般性的网络加速结论需要重复控制测量。

[互联网访问指南](/zh/guide/internet-access) 说明当前路由、缓存与恢复契约。这组测量覆盖本地命令发现和选定 HTTP 端点，Exa 与 Context7 的托管检索质量尚未纳入实测。

<!-- PRODUCT-SURFACE:begin -->

## 当前产品能力对照

这组数据按各项目公开声明的范围对照。目录数量用于观察覆盖面。Uni-CLI 任务集验证用户能否从已发布命令行找到操作并准备执行。

| 产品                                                  | 源码版本                                                                                                        | 公开范围                           | 当前规模                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| Uni-CLI                                               | 2026-10-10 工作区                                                                                               | 网站、浏览器、桌面、系统和本地工具 | 338 个网站，1893 条命令                               |
| [OpenCLI](https://github.com/jackwener/opencli)       | [77af6bc](https://github.com/jackwener/opencli/blob/77af6bc433c1818a4abb1c8928e2a7fd0bbae376/cli-manifest.json) | 网站和浏览器 adapter runtime       | 169 个网站，1215 条命令                               |
| [CLI-Anything](https://github.com/HKUDS/CLI-Anything) | [34f5195](https://github.com/HKUDS/CLI-Anything/blob/34f519533bc175d2fe287ab8316b0dd99bb9cc43/registry.json)    | 有状态 harness 和能力矩阵          | 79 个 harness，24 个公开入口，5 个矩阵，62 项矩阵能力 |

统一的个人内容分类会略过 `whoami` 这类身份查询。表格使用同一分类器报告当前数量。覆盖数量作为比较结果保留，维护检查验证实际任务和目录一致性。

| 个人内容范围 | Uni-CLI | OpenCLI |
| ------------ | ------- | ------- |
| 命令         | 80      | 81      |
| 网站         | 38      | 47      |

### 已发布发现任务

Uni-CLI 有 14/14 个任务排在首位。14/14 个首位结果同时带有运行命令、参数查看命令和所需认证设置。个性化任务通过 5/5 个。

| 任务                    | 预期命令                | 首位结果                | 可直接准备 |
| ----------------------- | ----------------------- | ----------------------- | ---------- |
| news-top                | `hackernews top`        | `hackernews top`        | 是         |
| developer-trending      | `github-trending daily` | `github-trending daily` | 是         |
| developer-code-search   | `gh search-code`        | `gh search-code`        | 是         |
| media-playback          | `spotify play-track`    | `spotify play-track`    | 是         |
| auth-setup              | `auth setup`            | `auth setup`            | 是         |
| cli-upgrade             | `upgrade install`       | `upgrade install`       | 是         |
| harness-evolution       | `evolve adapter`        | `evolve adapter`        | 是         |
| evolution-evidence      | `runs distill`          | `runs distill`          | 是         |
| agent-plugin-inspection | `plugin inspect`        | `plugin inspect`        | 是         |
| xiaohongshu-saved       | `xiaohongshu saved`     | `xiaohongshu saved`     | 是         |
| instagram-saved         | `instagram saved`       | `instagram saved`       | 是         |
| zhihu-recommendations   | `zhihu recommend`       | `zhihu recommend`       | 是         |
| twitter-notifications   | `twitter notifications` | `twitter notifications` | 是         |
| bilibili-history        | `bilibili history`      | `bilibili history`      | 是         |

### 维护检查

- 根命令发现入口 6/6
- 生成目录同步 通过
- OpenCLI 固定基准完整性 通过
- 个人内容命令数量比较 低于对照数量
- 产品能力检查 通过

运行 `npm run bench:product-surface` 可以重新生成本节。

<!-- PRODUCT-SURFACE:end -->
