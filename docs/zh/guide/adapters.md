---
title: 创建适配器
description: 用 YAML adapter 把新站点或工具加入 Uni-CLI，并在本机完成测试。
---

# 创建适配器

Adapter 会把一个实用动作变成可搜索的 Uni-CLI operation。YAML 是默认格式，metadata、参数和 pipeline steps 都放在同一个文件中。

## 创建文件

```bash
unicli init example search
```

生成文件位于 `src/adapters/example/search.yaml`。`-o` 可以选择目录，`-t` 可以选择 `web-api`、`browser`、`desktop`、`bridge` 或 `service`。

## 描述操作

一个简短的公开 HTTP adapter：

```yaml
site: hackernews
name: top
description: Hacker News top stories
type: web-api
strategy: public
target_surface: web
execution_operator: structured-api
operation_family: list
operation_effect: read
args:
  - name: limit
    type: int
    default: 20
pipeline:
  - fetch:
      url: https://news.ycombinator.com/
  - select:
      selector: .athing
      fields:
        title: .titleline > a
        url: .titleline > a@href
  - limit: ${{ args.limit }}
capabilities: ["http.fetch"]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false
schema_version: v2
```

Description 应贴近用户意图。Contract 字段帮助搜索、权限策略和 Agent 客户端在执行前选中操作。

## 选择类型

| 类型      | 适用场景                                        |
| --------- | ----------------------------------------------- |
| `web-api` | HTTP API、feed 与结构化网页响应                 |
| `browser` | 登录页面、DOM action 与 browser network capture |
| `desktop` | 本机 App 与可执行程序                           |
| `bridge`  | `gh`、`docker` 等已有 CLI                       |
| `service` | 本机或远程 HTTP、WebSocket 服务                 |

Type 表示集成类型，`execution_operator` 记录实际执行接口。

## 定义参数

```yaml
args:
  - name: query
    type: str
    required: true
    positional: true
    description: Search terms
  - name: limit
    type: int
    default: 10
    minimum: 1
    maximum: 100
```

参数支持 JSON Schema constraint，以及 path、ID、selector 和 URL 等 Uni-CLI kind。完整字段见[适配器格式](/zh/ADAPTER-FORMAT)。

## 编写 pipeline

Pipeline step 会接收当前 context，并可在模板表达式中引用参数。

```yaml
pipeline:
  - fetch:
      url: https://example.com/search?q=${{ args.query }}
  - select:
      selector: article
      fields:
        title: h2
        url: a@href
  - limit: ${{ args.limit }}
```

可用 action 见 [Pipeline steps](/zh/reference/pipeline)。

## 本地运行

```bash
unicli dev src/adapters/example/search.yaml
unicli describe example search
unicli example search "test" --limit 3 -f json
unicli test example
```

行为稳定后，为对应路径加入最小的 test 或 fixture。

## 自定义流程使用 TypeScript

SDK、streaming protocol、stateful service 和复杂 control flow 更适合 TypeScript adapter。它们注册相同 operation metadata，并返回相同 envelope。

TypeScript 合同见[适配器格式](/zh/ADAPTER-FORMAT#typescript-escape-hatch)。
