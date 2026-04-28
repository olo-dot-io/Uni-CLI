# 自修复

Uni-CLI 的 adapter 是给智能体读和改的。命令失败时，先读错误信封，找到坏掉的 adapter 和 pipeline step，再做小修复。

## 失败时会看到什么

错误会用 v2 `AgentEnvelope` 返回，重点看这些字段：

| 字段                 | 含义                                                               |
| -------------------- | ------------------------------------------------------------------ |
| `error.code`         | 失败类型，比如 `auth_required`、`selector_miss`、`network_error`。 |
| `error.adapter_path` | 需要打开的 adapter 文件。                                          |
| `error.step`         | 出问题的 pipeline step 序号。                                      |
| `error.retryable`    | 是否值得自动重试。                                                 |
| `error.suggestion`   | 下一步建议。                                                       |
| `error.alternatives` | 可尝试的替代命令。                                                 |

## 修复循环

```text
1. 运行命令，保留错误信封。
2. 打开 error.adapter_path。
3. 只改失败 step 附近的最小逻辑。
4. 保存到 ~/.unicli/adapters/SITE/COMMAND.yaml。
5. 运行 unicli repair SITE COMMAND。
6. 再跑原命令。
```

本地覆盖放在 `~/.unicli/adapters/`，升级 npm 包后仍然保留。

## 常见修法

| 现象            | 通常怎么修                                                  |
| --------------- | ----------------------------------------------------------- |
| `selector_miss` | 页面结构变了，更新 `wait`、`click`、`extract` 等 selector。 |
| `auth_required` | 运行 `unicli auth setup SITE`，确认 Cookie 文件存在。       |
| `network_error` | 检查 URL、参数、请求头和是否被限流。                        |
| `invalid_input` | 补充 args schema，或者把错误提示写清楚。                    |
| `quarantined`   | 先看 quarantine 原因，按风险门禁处理。                      |

## YAML 为什么适合自修复

大多数 adapter 是短 YAML：没有 imports，没有构建步骤，也没有隐藏状态。智能体可以读懂 pipeline，每次只改一小块。

```yaml
pipeline:
  - fetch: { url: "https://api.example.com/items" }
  - select: data.items
  - map:
      title: "${{ item.title }}"
      url: "${{ item.url }}"
```

如果命令需要复杂运行时代码，再使用 TypeScript adapter；简单 fetch 保持 YAML。

## 验证

```bash
unicli repair SITE COMMAND
unicli SITE COMMAND -f json
npm run lint:adapters
npm run lint:schema-v2
```

修复成功的标准是返回的数据形状符合命令的公开合同。
