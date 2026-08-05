<!-- 由 docs/zh/BENCHMARK.md 生成。不要直接编辑此副本。 -->

# 基准

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/BENCHMARK
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/BENCHMARK.md
- 栏目: 项目
- 上级: 项目 (/zh/ARCHITECTURE)

基准套件测量 Agent 直接遇到的成本：冷启动、完整目录大小和代表性操作的响应大小。

## 运行

```bash
npm run bench
```

CI 使用固定 fixture：

```bash
BENCH_FIXTURES_ONLY=1 npm run bench
```

每条 root CLI measurement 都启动新进程。Adapter fixture timing 只覆盖进程内解析与格式化，live mode 会加入命令使用的 subprocess 与 network path。

## 当前目录

- <span><!-- STATS:site_count -->326<!-- /STATS --></span> 个静态 adapter site
- <span><!-- STATS:command_count -->1830<!-- /STATS --></span> 条注册 adapter command
- <span><!-- STATS:adapter_count_yaml -->980<!-- /STATS --></span> 个 schema-v2 YAML adapter
- <span><!-- STATS:pipeline_step_count -->113<!-- /STATS --></span> 个 built-in action
- <span><!-- STATS:test_count -->9995<!-- /STATS --></span> 个 test

完整 p50、p95、运行环境和生成时间见[英文报告](/BENCHMARK)。

## 如何阅读

- `unicli --help` 与 `unicli --version` 测量最小 process startup path。
- `unicli list -f json` 测量目录载入与 serialization。
- Adapter case 使用 `--limit 5`，对应常见 Agent retrieval call。
- 日常发现使用 search 和 describe；完整目录在明确请求时输出。

常见 list operation 的公开目标是在 `--limit 5` 时保持 600 total tokens 或更少。更大的 command result 应提供 limit、pagination 或 compact output。
