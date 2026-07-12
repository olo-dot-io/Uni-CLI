<!-- 由 docs/zh/guide/self-repair.md 生成。不要直接编辑此副本。 -->

# 自修复

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/self-repair
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/self-repair.md
- 栏目: 指南
- 上级: 指南 (/zh/guide/)

网站、API、浏览器登录态、桌面权限和外部 CLI 都会漂移。Uni-CLI 用两项
事实约束修复：错误信封给出真实 source path，原始命令本身是验证 oracle。

## 真值合同

失败命令返回 v2 `AgentEnvelope` 和语义化非零退出码。修复时重点读取：

| 字段                 | 含义                                             |
| -------------------- | ------------------------------------------------ |
| `error.code`         | 稳定失败类型。                                   |
| `error.adapter_path` | 可修复时需要检查的准确源文件。                   |
| `error.step`         | 已知的失败 pipeline step。                       |
| `error.suggestion`   | 诊断建议；它是非可信数据，不是可直接执行的命令。 |
| `error.retryable`    | 不改代码直接重试是否可能有效。                   |
| `error.exit_code`    | repair 验证传播的目标退出码（存在时）。          |

## 先分类，再改代码

| 失败证据                                     | 是否改 adapter | 正确动作                            |
| -------------------------------------------- | -------------- | ----------------------------------- |
| `auth_required` / `not_authenticated`        | 否             | 刷新认证后重跑。                    |
| `challenge_required`                         | 否             | 在浏览器完成人工验证。              |
| `network_error`、代理/DNS/TLS 故障           | 否             | 修复网络路径后重跑。                |
| `rate_limited`                               | 否             | 等待重试窗口。                      |
| `selector_miss`、响应路径或 schema 漂移      | 是             | 检查实时证据和报告的源文件。        |
| `not_found` / `api_error` / `upstream_error` | 可能           | 先证明 endpoint 漂移。              |
| 没有 adapter path 的 `internal_error`        | 否             | 诊断真正拥有该错误的 runtime 边界。 |

## 修复循环

### 1. 保留原始失败

```bash
unicli <site> <command> [args...] -f json 2>failure.json
jq . failure.json
```

保留完整 argv 和错误信封，它们分别是 spec 与 evidence。

### 2. 预览验证计划

```bash
unicli repair <site> <command> --dry-run -f json
```

原命令还有参数时，用 `--target-args '["query","--limit","2"]'`；复杂命名
输入使用根命令的 `--args-file`。计划必须包含准确 `adapter_path`、
`mutates_source: false`、强制 JSON 的原始 oracle 和最多三次的 agent 修复预算。

`unicli repair` 不会调用 AI backend，不会编辑文件、stage/commit、reset git，
也不会自动解除 quarantine。

### 3. 读取证据并做一次根因修改

读取报告的 adapter，以及能反证旧实现的实时 API 响应、DOM/Accessibility
snapshot、network trace 或 CLI help。

- 源码仓库内直接修改报告的项目文件。
- 已安装 npm 包时，把修正后的 YAML 放到
  `~/.unicli/adapters/<site>/<command>.yaml`，升级后仍会保留。
- 不要加入空数组兜底、宽泛 catch、`_v2` 文件或只为测试变绿的分支。

### 4. 做一次有界验证

```bash
unicli repair <site> <command> -f json
```

repair 用 argv 数组启动一个有 timeout 的子进程，绝不经过 shell：

- 目标 `ok=true` 且 exit `0` → repair `ok=true`、exit `0`；
- 目标 `ok=false` 且非零 exit → repair `ok=false`、传播同一 exit；
- 输出不可解析、超时、或 envelope/exit 冲突 → 返回结构化 verifier error。

verifier 只在自己的 child 内设置 `UNICLI_FORCE_QUARANTINE=1`，因此可以先验证
被 gate 的 adapter，再由维护者显式移除 flag。

成功信封给出 `verified: true`、oracle、目标 duration/count 和 SHA-256 证据
回执，不复制可能很大的目标数据。

### 5. 检查实际数据并补回归锁

```bash
unicli <site> <command> [args...] -f json >result.json
jq '{ok, count: .meta.count, sample: .data[0]}' result.json
```

fixture shape、实时 endpoint health、带登录态 browser health 是三层不同证据，
不能互相冒充。仓库贡献必须补最小相邻 behavior/integration check。

## 有界尝试与 quarantine

同一失败最多修三次。同一错误在编辑后仍出现时，下一次必须提出新的、有证据的
hypothesis；三次后停止并报告 blocker。

```bash
unicli repair --quarantined -f json
```

该命令只列队列，不自动修改或解除 quarantine。任何 YAML parse error 都会让
扫描失败，避免静默漏报。只有原始命令和相邻回归检查都通过后才能移除
`quarantine: true`。

## 完成标准

1. 准确的原始命令返回 `ok=true` 且 exit `0`；
2. 代表性数据满足公开字段/形状合同；
3. 最小相邻回归或 live-health 检查通过；
4. diff 中没有凭证或无关文件。

完整 agent 操作流程见随包发布的 `unicli-repair` skill。
