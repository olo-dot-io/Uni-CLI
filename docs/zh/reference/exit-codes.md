# 退出码

Uni-CLI 用退出码告诉智能体下一步该做什么。stdout/stderr 里仍然会有结构化 `AgentEnvelope`，退出码只是快速路由信号。

## 总览

| Code | 名称        | 含义              | 智能体动作                                 |
| ---- | ----------- | ----------------- | ------------------------------------------ |
| 0    | ok          | 成功              | 使用 `data`。                              |
| 66   | empty       | 没有结果          | 换查询、分页或参数。                       |
| 69   | unavailable | 上游不可用        | 稍后重试，或换替代命令。                   |
| 75   | temp-fail   | 临时失败          | 退避重试。                                 |
| 77   | auth        | 需要认证或权限    | 运行 `unicli auth setup SITE` 或检查凭据。 |
| 78   | config      | 配置/adapter 错误 | 读错误信封，修 adapter。                   |

## 成功

退出码 `0` 表示命令完成。输出里通常有：

```yaml
ok: true
schema_version: "2"
command: "hackernews.top"
data:
  - title: "..."
error: null
```

## 空结果

退出码 `66` 不是崩溃。它说明命令跑完了，但没有匹配数据。

常见动作：

- 放宽搜索词。
- 调整 `--limit` 或分页 cursor。
- 换一个更宽的命令。

## 服务不可用

退出码 `69` 表示当前接口或本地应用不可用。可能是网络、上游、桌面应用未启动、平台能力缺失。

先看 `error.retryable`。如果为 `true`，可以重试；如果为 `false`，优先看 `error.suggestion`。

## 临时失败

退出码 `75` 适合自动退避重试。不要无限重试，给自己设上限。

## 认证失败

退出码 `77` 表示需要登录、Cookie、token 或权限。

```bash
unicli auth setup SITE
unicli auth check SITE
```

## 配置错误

退出码 `78` 表示 adapter、schema 或本地配置有问题。读这些字段：

- `error.adapter_path`
- `error.step`
- `error.suggestion`
- `error.alternatives`

然后进入 [自修复](/zh/guide/self-repair)。
