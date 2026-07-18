# 基准

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

## 证据边界

- `--version`、`--help` 和 `list -f json` 分别以全新 Node subprocess 测量；
- fixture adapter 时间只代表进程内解析/序列化，不冒充 CLI 或网络延迟；
- live adapter 时间包含真实 subprocess 与网络；
- MCP 与 Browser Runtime Broker 等常驻进程的 warm latency 未在本页推断。

当前生成时间、运行环境、p50/p95 和完整结果见英文主报告
[`docs/BENCHMARK.md`](../BENCHMARK.md)。

## 当前公开指标

这些数字来自仓库生成的 `stats.json` 和静态 adapter manifest；固定 core
与主机动态发现命令不在下面的站点/命令总数中：

- <span><!-- STATS:site_count -->324<!-- /STATS --></span> 个静态 adapter 站点。
- <span><!-- STATS:command_count -->1817<!-- /STATS --></span> 条已注册 adapter 命令。
- <span><!-- STATS:adapter_count_yaml -->994<!-- /STATS --></span> 个 schema-v2 YAML adapter。
- <span><!-- STATS:pipeline_step_count -->105<!-- /STATS --></span> 个 built-in action（<span><!-- STATS:pipeline_registered_step_count -->50<!-- /STATS --></span> 个 registered + <span><!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --></span> 个 transport-native）。
- <span><!-- STATS:test_count -->9659<!-- /STATS --></span> 个测试。

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
