---
title: 适配器格式
description: Uni-CLI YAML adapter 与 TypeScript 注册路径的完整字段参考。
---

# 适配器格式

一个 YAML 适配器注册一条命令。文件中包含供命令发现使用的元数据、参数、执行步骤、输出列和 schema-v2 元数据。

## 最小示例

```yaml
site: hackernews
name: top
description: Hacker News top stories
domain: news.ycombinator.com
type: web-api
strategy: public
operation_effect: read

args:
  limit:
    type: int
    default: 20
    description: Number of stories

pipeline:
  - fetch:
      url: https://hacker-news.firebaseio.com/v0/topstories.json
  - limit: ${{ args.limit }}

columns: [id]

capabilities: ["http.fetch"]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false
schema_version: v2
```

## 标识与连接

| 字段                | 含义                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `site`              | 命令 namespace，例如 `hackernews`                                |
| `name`              | Site 下的命令名                                                  |
| `description`       | Search 使用的一句话用户意图                                      |
| `domain`            | 主要远程域名                                                     |
| `type`              | `web-api`、`browser`、`desktop`、`bridge` 或 `service`           |
| `strategy`          | `public`、`cookie`、`header`、`environment`、`intercept` 或 `ui` |
| `browser`           | 标记需要 browser runtime 的命令                                  |
| `browserSession`    | `auto`、`user` 或 `cdp`                                          |
| `auth_cookies`      | Site adapter 使用的 cookie 名称                                  |
| `binary` / `detect` | Bridge adapter 的外部 CLI 与检测命令                             |

## Operation metadata

| 字段                 | 可用值                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_surface`     | `web`、`desktop`、`system`、`mobile`                                                                                                                                                           |
| `execution_operator` | `structured-api`、`browser-protocol`、`native-cli`、`browser-semantic`、`desktop-accessibility`、`visual-observation`、`visual-coordinate`、`local-runtime`                                    |
| `operation_family`   | `search`、`get`、`list`、`create`、`update`、`delete`、`invoke`、`capture`、`navigate`、`download`、`authenticate`、`unknown`                                                                  |
| `operation_effect`   | `read`、`download_file`、`send_message`、`publish_content`、`account_state`、`remote_transform`、`remote_resource`、`service_state`、`local_app`、`local_file`、`destructive`、`unknown_write` |
| `idempotency`        | `guaranteed`、`conditional`、`none`、`unknown`                                                                                                                                                 |
| `auth_requirement`   | `required`、`optional`、`none`                                                                                                                                                                 |

## 配置可用性

使用进程凭据的命令需要单独声明配置要求。`strategy: environment` 表示流水线从环境变量模板读取凭据，执行时不访问浏览器 cookie 存储。

```yaml
strategy: environment
auth_requirement: required
availability:
  environment: [SEARCH_API_KEY]
  discovery: configured
  setup_url: https://search.example.com/keys
```

`availability.environment` 中的变量全部为必填项。配置 `discovery: configured` 后，缺少凭据的命令会从 list、search、completion 和 expanded MCP 中隐藏。显式调用 describe 仍可查看命令契约及 `missing_environment`。配置不完整时，直接调用会在发起网络请求前结束。

## Retrieval provider

只读检索命令可以声明来源元数据，加入 `unicli retrieval search`。

```yaml
retrieval:
  operation: discover
  result_kind: docs
  source_class: search-index
  selection: explicit
  arguments:
    query: query
    limit: limit
```

`selection` 默认为 `automatic`。自动选择和 `all` 只使用已配置、无需认证的自动来源。付费或消耗配额的提供方使用 `selection: explicit`，调用方必须传入准确的来源引用或站点名称。

## 参数

YAML 参数以命令行参数名作为键。

```yaml
args:
  query:
    type: str
    required: true
    positional: true
    minLength: 1
    description: Search terms
  limit:
    type: int
    default: 10
    minimum: 1
    maximum: 100
  sort:
    type: str
    choices: [relevance, newest]
    default: relevance
```

类型包括 `str`、`str[]`、`int`、`float`、`nullable-float`、`str-or-int` 和 `bool`。

字符串参数支持 `minLength`、`maxLength`、`pattern`，以及 `uri`、`uuid`、`date`、`date-time`、`email`、`hostname`、`ipv4`、`ipv6`、`regex` 等标准格式。Uni-CLI 的参数类别还提供 `path`、`adapter-ref`、`selector`、`shell-safe` 与 `id` 验证。

## Pipeline

`pipeline` 是按顺序执行的动作对象列表。

```yaml
pipeline:
  - fetch:
      url: https://api.example.com/search
      params:
        q: ${{ args.query }}
  - select: data.items
  - map:
      title: ${{ item.title }}
      url: ${{ item.url }}
  - limit: ${{ args.limit }}
```

模板可以读取 `args`、当前 `item` 与 `index`、环境变量和前面步骤存储的数据。详情见 [Pipeline steps](/zh/reference/pipeline)。

## 输出

`columns` 控制默认 Markdown、表格和 CSV 的字段顺序。JSON 保留完整结果。

```yaml
columns: [title, url, score]
defaultFormat: md
```

需要更明确的输出契约时，可以在 `output` 中声明结果 Schema 和 Agent 提示。

## Schema-v2 必填 metadata

提交到仓库的 YAML 适配器需要包含以下六个字段。

| 字段                 | 用途                                       |
| -------------------- | ------------------------------------------ |
| `schema_version: v2` | 选择当前 adapter metadata schema           |
| `capabilities`       | 列出命令使用的 capability                  |
| `minimum_capability` | 执行所需的最小接口                         |
| `trust`              | `public`、`user` 或 `system` 来源          |
| `confidentiality`    | `public`、`internal` 或 `private` 数据类别 |
| `quarantine`         | 标记等待修复的 adapter                     |

使用下面的命令为已有适配器补充元数据。

```bash
unicli migrate schema-v2 path/to/adapter.yaml --write
```

## TypeScript adapter

SDK 集成、流式协议、自定义分页和有状态流程适合使用 TypeScript。

```typescript
import { cli, Strategy } from "../../registry.js";

cli({
  site: "example",
  name: "search",
  description: "Search Example",
  strategy: Strategy.PUBLIC,
  args: [{ name: "query", type: "str", required: true, positional: true }],
  capabilities: ["http.fetch"],
  minimum_capability: "http.fetch",
  trust: "public",
  confidentiality: "public",
  quarantine: false,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "search",
  func: async (_page, { query }) => {
    const response = await fetch(
      `https://api.example.com/search?q=${encodeURIComponent(String(query))}`,
    );
    return response.json();
  },
});
```

TypeScript 注册时直接调用注册表 API，参数采用数组形式。

## 验证

```bash
npm run lint:adapters
npm run lint:schema-v2
unicli describe <site> <command>
unicli test <site>
```

加载器位于 `src/core/yaml-adapter.ts`，v2 元数据 Schema 位于 `src/core/schema-v2.ts`。
