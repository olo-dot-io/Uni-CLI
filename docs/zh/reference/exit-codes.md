---
title: 退出码
description: 根据 Uni-CLI 进程状态在脚本和 Agent 中选择下一步。
---

# 退出码

Uni-CLI 在 stderr 中同时返回进程退出码和结构化错误 envelope。`error.code` 表示具体原因，`error.suggestion` 给出下一条命令。

| 代码 | 名称                    | 含义                                  | 常见下一步                              |
| ---: | ----------------------- | ------------------------------------- | --------------------------------------- |
|    0 | success                 | 操作完成                              | 读取 `data`                             |
|    1 | generic error           | 运行时出现意外错误                    | 阅读 envelope 与日志                    |
|    2 | usage error             | 命令或参数无效                        | 运行 `unicli describe` 或 `unicli help` |
|   66 | empty result            | 请求完成，但没有匹配项                | 调整查询或标识符                        |
|   69 | service unavailable     | 需要的服务、provider 或工具当前不可用 | 执行 `error.suggestion`                 |
|   75 | temporary failure       | 出现超时、限流或网络错误              | 按建议等待后重试                        |
|   77 | authentication required | 需要登录或权限                        | 运行返回的认证或授权命令                |
|   78 | configuration error     | adapter 或本地配置需要调整            | 查看结果中标明的源文件                  |

## Shell 示例

```bash
if output=$(unicli hackernews top --limit 5 -f json); then
  printf '%s\n' "$output" | jq '.data'
else
  status=$?
  printf 'Uni-CLI exited with %s\n' "$status" >&2
fi
```

## Agent 示例

```text
用 -f json 运行命令。
退出码为 0 时读取 data。
退出码为 75 时等待后重试。
其他失败读取 error.code、error.suggestion 和 error.remedy.command。
```

退出码常量定义在 `src/core/envelope.ts`。
