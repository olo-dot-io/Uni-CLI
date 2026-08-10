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

每条 root CLI measurement 都启动新进程。Adapter fixture timing 只覆盖进程内解析与格式化，live mode 会加入命令使用的 subprocess 与 network path。

## 当前目录

- <span><!-- STATS:site_count -->337<!-- /STATS --></span> 个静态 adapter site
- <span><!-- STATS:command_count -->1890<!-- /STATS --></span> 条注册 adapter command
- <span><!-- STATS:adapter_count_yaml -->1008<!-- /STATS --></span> 个 schema-v2 YAML adapter
- <span><!-- STATS:pipeline_step_count -->113<!-- /STATS --></span> 个 built-in action
- <span><!-- STATS:test_count -->10334<!-- /STATS --></span> 个 test

完整 p50、p95、运行环境和生成时间见[英文报告](/BENCHMARK)。

## 如何阅读

- `unicli --help` 与 `unicli --version` 测量最小 process startup path。
- `unicli list -f json` 测量目录载入与 serialization。
- Adapter case 使用 `--limit 5`，对应常见 Agent retrieval call。
- 日常发现使用 search 和 describe；完整目录在明确请求时输出。

常见 list operation 的公开目标是在 `--limit 5` 时保持 600 total tokens 或更少。更大的 command result 应提供 limit、pagination 或 compact output。

<!-- PRODUCT-SURFACE:begin -->

## 当前产品能力对照

这组数据按各项目公开声明的范围对照。目录数量用于观察覆盖面。Uni-CLI 任务集验证用户能否从已发布命令行找到操作并准备执行。

| 产品                                                  | 源码版本                                                                                                        | 公开范围                           | 当前规模                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| Uni-CLI                                               | 2026-08-10 工作区                                                                                               | 网站、浏览器、桌面、系统和本地工具 | 337 个网站，1890 条命令                               |
| [OpenCLI](https://github.com/jackwener/opencli)       | [a86d647](https://github.com/jackwener/opencli/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/cli-manifest.json) | 网站和浏览器 adapter runtime       | 176 个网站，1331 条命令                               |
| [CLI-Anything](https://github.com/HKUDS/CLI-Anything) | [39634a6](https://github.com/HKUDS/CLI-Anything/blob/39634a640cf20bc603b4faae4d31069c44821a9a/registry.json)    | 有状态 harness 和能力矩阵          | 79 个 harness，22 个公开入口，5 个矩阵，62 项矩阵能力 |

统一的个人内容分类会略过 `whoami` 这类身份查询。Uni-CLI 的个人内容命令数量更多，OpenCLI 覆盖的网站数量更多。

| 个人内容范围 | Uni-CLI | OpenCLI |
| ------------ | ------- | ------- |
| 命令         | 80      | 78      |
| 网站         | 38      | 44      |

### 已发布发现任务

Uni-CLI 有 11/11 个任务排在首位。11/11 个首位结果同时带有运行命令、参数查看命令和所需认证设置。个性化任务通过 5/5 个。

| 任务                  | 预期命令                | 首位结果                | 可直接准备 |
| --------------------- | ----------------------- | ----------------------- | ---------- |
| news-top              | `hackernews top`        | `hackernews top`        | 是         |
| developer-trending    | `github-trending daily` | `github-trending daily` | 是         |
| developer-code-search | `gh search-code`        | `gh search-code`        | 是         |
| media-playback        | `spotify play-track`    | `spotify play-track`    | 是         |
| auth-setup            | `auth setup`            | `auth setup`            | 是         |
| cli-upgrade           | `upgrade install`       | `upgrade install`       | 是         |
| xiaohongshu-saved     | `xiaohongshu saved`     | `xiaohongshu saved`     | 是         |
| instagram-saved       | `instagram saved`       | `instagram saved`       | 是         |
| zhihu-recommendations | `zhihu recommend`       | `zhihu recommend`       | 是         |
| twitter-notifications | `twitter notifications` | `twitter notifications` | 是         |
| bilibili-history      | `bilibili history`      | `bilibili history`      | 是         |

### 维护检查

- 根命令发现入口 5/5
- 生成目录同步 通过
- OpenCLI 固定基准完整性 通过
- 个人内容命令对等检查 通过
- 产品能力检查 通过

运行 `npm run bench:product-surface` 可以重新生成本节。

<!-- PRODUCT-SURFACE:end -->
