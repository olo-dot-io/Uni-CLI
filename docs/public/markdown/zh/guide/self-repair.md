<!-- 由 docs/zh/guide/self-repair.md 生成。不要直接编辑此副本。 -->

# 自修复

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/self-repair
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/self-repair.md
- 栏目: 使用 Uni-CLI
- 上级: 使用 Uni-CLI (/zh/guide/)

真实软件会变化。Uni-CLI 可以把一次失败定位到 adapter 源文件，并给出可重复运行的验证命令。

## 读取 envelope

用 JSON 运行目标操作，并保留原参数。

```bash
unicli <site> <command> [args] -f json
```

Adapter failure 可能包含以下字段。

```json
{
  "ok": false,
  "error": {
    "code": "adapter_error",
    "adapter_path": "src/adapters/example/search.yaml",
    "step": 2,
    "suggestion": "Inspect the selector used by step 2",
    "retryable": false
  }
}
```

`adapter_path` 指向对应源文件，`step` 指向产生失败的 pipeline action。

## 预览验证

```bash
unicli repair <site> <command> --dry-run
```

带参数的命令可以传入原 argv。

```bash
unicli repair <site> <command> \
  --target-args '["query","--limit","2"]' \
  --dry-run
```

预览会显示 adapter path、命令、参数、超时和工作目录。

## 更新对应实现

查看命名的 adapter，以及上游响应或页面状态。常见变化包括以下情况。

- endpoint 或 response field 发生变化
- selector 更新
- header 或 cookie 发生变化
- 外部 CLI 调整输出
- 桌面权限或 provider 需要配置

更新 adapter 或对应 runtime component。行为稳定后，加入一个聚焦的 regression check。

## 运行 verifier

```bash
unicli repair <site> <command> \
  --target-args '["query","--limit","2"]'
```

验证成功时，原操作返回 exit code 0 和成功 envelope。

## 本机修复

适合单台机器或仍在测试的修复可以放到 `~/.unicli/adapters/<site>/`。User adapter 对相同 site 和 command 拥有更高加载优先级。

## Quarantined adapter

列出等待修复的命令。

```bash
unicli repair --quarantined
```

源文件更新且目标 verifier 成功后，维护者可以把 adapter 放回常规测试集合。

## 把重复 repair 接入 evolution

一次成功 replay 不足以支持持久 override 时，可以创建 evolution session。Proposal evidence、validation case 和 held-out case 需要保持分离。

```bash
unicli --record <site> <command> [args]
unicli runs list -f json

unicli -f json evolve adapter <site> <command> \
  --run <proposal-run> \
  --candidate <candidate.yaml> \
  --hypothesis "<expected mechanism>" \
  --expect <validation-case-id> \
  --risk <held-out-case-id> \
  --validation <validation-eval.yaml> \
  --held-out <held-out-eval.yaml> \
  --promote
```

这条直接路径在一次调用中创建 session、提炼 proposal run、执行隔离的 baseline 与 candidate overlay、评估预测、应用 promotion gate，并安装 override。Proposal evidence 保留 trace reference 和脱敏 failure summary，不包含 replay 参数与 secret event field，并把提炼后的 trace content 标记为 untrusted。

```bash
unicli -f json evolve inspect
unicli -f json evolve verify <session-id> --promote
unicli -f json evolve rollback <session-id>
```

省略 `--candidate` 可以创建 draft。编辑返回的 `candidate.path` 后，再运行 `evolve verify`。Candidate 没有变化、validation 未严格提升、validation 出现 regression、held-out eval 为空或 held-out case 回退时，gate 都会保留 baseline。Promotion 写入 `~/.unicli/adapters/<site>/<command>.yaml`。`rollback` 恢复 promotion 前的 overlay；文件在 promotion 后被修改时，rollback 会停止并报告冲突。

每次 verification 都会追加一个 attempt directory，其中包含对应的 candidate、patch 和 report。Content hash 发生变化时，后续操作会停止。Agent 编辑 draft 并再次验证后，原有 rejected attempt 仍然保持完整。Verified draft 未变化时，`evolve verify <session-id> --promote` 会安装已有 attempt，不会重复运行 eval case。多个 promotion 或 rollback process 会按 session 串行执行。写入中断后的操作会从已准备的 promotion record 继续。

Read-only operation 默认可以进入 gate。只有全部 validation target 都位于预期的受控环境时，才使用 `--allow-mutation-eval`。Candidate 可以修复同一 origin 内的 endpoint path、selector、extraction expression 和已有 pipeline action config。Candidate 不能改变 operation identity、输入输出 contract、pipeline action topology、request method 与 header，或已有 subprocess invocation。替换 network origin 时，创建 session 的命令必须传入 `--allow-origin <origin>`。
