---
title: 自修复
description: 读取 adapter failure，更新对应源文件，并验证原操作。
---

# 自修复

操作失效时，先根据错误定位适配器源文件，再运行可重复的验证命令。Uni-CLI 保留原参数和失败步骤，便于将修复限定在对应实现中。

## 读取 envelope

用 JSON 运行目标操作，并保留原参数。

```bash
unicli <site> <command> [args] -f json
```

适配器错误可能包含以下字段。

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

`adapter_path` 指向对应源文件，`step` 指向产生失败的流水线动作。

## 预览验证

```bash
unicli repair <site> <command> --dry-run
```

命令带有参数时，将原命令的参数列表作为 JSON 传入。

```bash
unicli repair <site> <command> \
  --target-args '["query","--limit","2"]' \
  --dry-run
```

预览会显示适配器路径、命令、参数、超时和工作目录。

## 更新对应实现

查看错误指出的适配器，以及上游响应或页面状态。常见变化包括以下情况。

- 请求端点或响应字段发生变化
- 页面选择器更新
- 请求头或 cookie 发生变化
- 外部 CLI 调整输出
- 桌面权限或驱动需要配置

更新适配器或负责该行为的运行时组件。行为稳定后，加入覆盖实际失败路径的回归场景。

## 运行 verifier

```bash
unicli repair <site> <command> \
  --target-args '["query","--limit","2"]'
```

验证成功时，原操作返回退出码 0 和成功响应。

## 本机修复

适合单台机器或仍在测试的修复可以放到 `~/.unicli/adapters/<site>/`。站点和命令名称相同时，用户适配器的加载优先级高于包内版本。

## Quarantined adapter

列出等待修复的命令。

```bash
unicli repair --quarantined
```

源文件更新且目标验证成功后，维护者可以将适配器恢复到常规测试集合。

## 把重复 repair 接入 evolution

准备长期保留修复时，可以创建演进会话，分别保存修改依据、验证用例和保留测试用例，比较修复前后的行为。

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

这条命令在一次调用中创建会话，整理提案记录，并执行隔离的基线与候选实现。评估通过晋级条件后，命令安装覆盖版本。修改依据保留执行轨迹引用和脱敏的失败摘要，排除重放参数与私密事件字段，并将提炼后的轨迹内容标记为不可信数据。

```bash
unicli -f json evolve inspect
unicli -f json evolve verify <session-id> --promote
unicli -f json evolve rollback <session-id>
```

省略 `--candidate` 可以创建草稿。编辑返回的 `candidate.path` 后，再运行 `evolve verify`。候选实现没有变化、验证未严格提升、验证用例退化、保留测试为空或保留测试退化时，系统都会保留基线。晋级会写入 `~/.unicli/adapters/<site>/<command>.yaml`。`rollback` 恢复晋级前的覆盖版本；晋级后文件又被修改时，回滚会停止并报告冲突。

每次验证都会新增一个尝试目录，保存对应的候选实现、补丁和报告。内容哈希变化时，后续操作会停止。Agent 编辑草稿并再次验证后，原有拒绝记录仍然完整保留。已验证的草稿没有变化时，`evolve verify <session-id> --promote` 直接安装已有合格版本，省去重复评估。多个晋级或回滚进程按会话串行执行。写入中断后，操作会从已准备的晋级记录继续。

只读操作默认可接受评估。全部验证目标都位于预期的受控环境时，才能使用 `--allow-mutation-eval` 评估写操作。每个写操作用例还必须声明 `effectStatus` 判断条件，并要求结果为 `confirmed`。进程成功和效果确认共同构成晋级依据。候选实现可以修复同一来源内的端点路径、选择器、提取表达式和已有流水线动作配置。操作身份、输入输出契约、流水线动作结构、请求方法与请求头，以及已有子进程调用均保持固定。替换网络来源时，创建会话的命令必须传入 `--allow-origin <origin>`。
