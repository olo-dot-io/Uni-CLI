---
title: 自修复
description: 读取 adapter failure，更新对应源文件，并验证原操作。
---

# 自修复

真实软件会变化。Uni-CLI 可以把一次失败定位到 adapter 源文件，并给出可重复运行的验证命令。

## 读取 envelope

用 JSON 运行目标操作，并保留原参数：

```bash
unicli <site> <command> [args] -f json
```

Adapter failure 可能包含：

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

带参数的命令可以传入原 argv：

```bash
unicli repair <site> <command> \
  --target-args '["query","--limit","2"]' \
  --dry-run
```

预览会显示 adapter path、命令、参数、超时和工作目录。

## 更新对应实现

查看命名的 adapter，以及上游响应或页面状态。常见变化包括：

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

列出等待修复的命令：

```bash
unicli repair --quarantined
```

源文件更新且目标 verifier 成功后，维护者可以把 adapter 放回常规测试集合。
