<!-- 由 docs/zh/BENCHMARK.md 生成。不要直接编辑此副本。 -->

# 基准

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/BENCHMARK
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/BENCHMARK.md
- 栏目: 解释
- 上级: 解释 (/zh/ARCHITECTURE)

Uni-CLI 的基准关注智能体真正付出的成本：发现命令要多久、返回内容有多大、失败后能不能定位和修复。

## 衡量什么

| 维度              | 为什么重要                   |
| ----------------- | ---------------------------- |
| Discovery latency | 智能体先要找到正确命令。     |
| Output size       | 输出越小，后续推理越便宜。   |
| Structured errors | 失败后能不能自动决定下一步。 |
| Adapter coverage  | 能操作多少真实软件。         |
| Repairability     | 命令坏了以后能不能局部修。   |

## 本地基准命令

```bash
npm run bench
npm run bench:quick
npm run bench:agent
npm run bench:gate
```

## 当前公开指标

这些数字来自仓库生成的 `stats.json` 和 manifest：

- 235 个站点。
- 1448 条命令。
- 917 个 schema-v2 YAML adapter。
- 59 个 pipeline steps。
- 7396 个测试。

数字随开发更新，以 `npm run stats` 生成结果为准。

## 输出大小

同一条命令可以按消费方选择格式：

```bash
unicli hackernews top -f md
unicli hackernews top -f json
unicli hackernews top -f compact
```

人和智能体一起看时用 Markdown；脚本处理用 JSON；只做路由或摘要时用 compact。

## 失败成本

失败不是只有“报错”。好的失败应该告诉智能体：

- 错误类型是什么。
- 哪个 adapter 文件出问题。
- 哪个 pipeline step 出问题。
- 是否值得重试。
- 有什么替代命令。

这也是 Uni-CLI 把错误包装进 `AgentEnvelope` 的原因。
