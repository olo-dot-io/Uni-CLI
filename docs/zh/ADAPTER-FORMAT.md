# 适配器格式（v2）

这是写 Uni-CLI adapter 的规范。大多数 adapter 应该写成 YAML；只有 pipeline primitives 不够用时，才使用 TypeScript。

## 原则

1. **YAML first。** 如果命令能表达成有限 pipeline，就写 YAML。系统可以验证、迁移和自修复 YAML。
2. **Agent-editable。** adapter 要短，最好几十行内。智能体应该能读、改、验证。
3. **Deterministic。** 相同输入和相同上游状态，应得到可复现结果。
4. **Minimum capability。** 声明最小需要的能力，比如 `http.fetch`，不要过度声明。
5. **Structured output。** 成功和失败都走 v2 `AgentEnvelope`。

## YAML schema

最小示例：

```yaml
site: example
name: search
type: web-api
strategy: public
pipeline:
  - fetch:
      url: "https://api.example.com/search"
      params:
        q: "${{ args.query }}"
  - select: data.results
  - map:
      title: "${{ item.title }}"
      url: "${{ item.url }}"
args:
  query:
    type: str
    required: true
    positional: true
columns: [title, url]
```

## 必填字段

| 字段       | 含义                                                                 |
| ---------- | -------------------------------------------------------------------- |
| `site`     | 站点或工具名。                                                       |
| `name`     | 命令名。                                                             |
| `type`     | adapter 类型：`web-api`、`browser`、`desktop`、`bridge`、`service`。 |
| `strategy` | 访问策略，如 `public`、`cookie`、`ui`、`intercept`。                 |
| `pipeline` | 执行步骤。                                                           |

## Args

```yaml
args:
  query:
    type: str
    required: true
    positional: true
  limit:
    type: int
    default: 20
```

常见类型：`str`、`int`、`float`、`bool`、`json`。

## Pipeline

Pipeline 是顺序执行的步骤列表。常见步骤：

- `fetch` / `fetch_text`
- `select`
- `map`
- `filter`
- `sort`
- `limit`
- `each`
- `retry`
- `navigate`
- `click`
- `type`
- `snapshot`
- `exec`
- `write_temp`

详见 [管线步骤](/zh/reference/pipeline)。

## 输出

`columns` 定义 Markdown/table 默认展示字段：

```yaml
columns: [title, url, score]
```

JSON 输出保留完整对象。不要为了表格好看删掉机器需要的字段。

## 错误

失败时应该返回结构化错误，而不是裸 stderr：

```yaml
ok: false
schema_version: "2"
error:
  code: selector_miss
  adapter_path: src/adapters/example/search.yaml
  step: 2
  retryable: false
  suggestion: "Update the selector and run unicli repair example search."
```

## TypeScript escape hatch

当 YAML 不够用时，可以写 TypeScript adapter。适合这些情况：

- 复杂签名或加密。
- SDK 或二进制协议。
- 长状态机。
- 需要深度平台 API。

即使用 TypeScript，也要保持同样的命令名、args、输出和错误合同。

## 迁移和验证

```bash
npm run lint:adapters
npm run lint:schema-v2
npm run test:adapter
```

如果改了 schema，必须确认旧 adapter 还能迁移或给出清晰错误。
