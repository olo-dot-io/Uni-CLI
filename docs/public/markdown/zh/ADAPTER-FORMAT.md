<!-- 由 docs/zh/ADAPTER-FORMAT.md 生成。不要直接编辑此副本。 -->

# 适配器格式

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/ADAPTER-FORMAT
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/ADAPTER-FORMAT.md
- 栏目: 扩展
- 上级: 扩展 (/zh/guide/adapters)

一个 YAML adapter 注册一条命令。文件中包含 discovery metadata、参数、执行步骤、输出列和 schema-v2 metadata。

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

| 字段                | 含义                                                   |
| ------------------- | ------------------------------------------------------ |
| `site`              | 命令 namespace，例如 `hackernews`                      |
| `name`              | Site 下的命令名                                        |
| `description`       | Search 使用的一句话用户意图                            |
| `domain`            | 主要远程域名                                           |
| `type`              | `web-api`、`browser`、`desktop`、`bridge` 或 `service` |
| `strategy`          | `public`、`cookie`、`header`、`intercept` 或 `ui`      |
| `browser`           | 标记需要 browser runtime 的命令                        |
| `browserSession`    | `auto`、`user` 或 `cdp`                                |
| `auth_cookies`      | Site adapter 使用的 cookie 名称                        |
| `binary` / `detect` | Bridge adapter 的外部 CLI 与检测命令                   |

## Operation metadata

| 字段                 | 可用值                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_surface`     | `web`、`desktop`、`system`、`mobile`                                                                                                                                                           |
| `execution_operator` | `structured-api`、`browser-protocol`、`native-cli`、`browser-semantic`、`desktop-accessibility`、`visual-observation`、`visual-coordinate`、`local-runtime`                                    |
| `operation_family`   | `search`、`get`、`list`、`create`、`update`、`delete`、`invoke`、`capture`、`navigate`、`download`、`authenticate`、`unknown`                                                                  |
| `operation_effect`   | `read`、`download_file`、`send_message`、`publish_content`、`account_state`、`remote_transform`、`remote_resource`、`service_state`、`local_app`、`local_file`、`destructive`、`unknown_write` |
| `idempotency`        | `guaranteed`、`conditional`、`none`、`unknown`                                                                                                                                                 |
| `auth_requirement`   | `required`、`optional`、`none`                                                                                                                                                                 |

## 参数

YAML 参数以命令行名称为 key。

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

字符串参数可以使用 `minLength`、`maxLength`、`pattern` 和 `uri`、`uuid`、`date`、`date-time`、`email`、`hostname`、`ipv4`、`ipv6`、`regex` 等标准 format。Uni-CLI kind 提供 `path`、`adapter-ref`、`selector`、`shell-safe` 与 `id` 验证。

## Pipeline

`pipeline` 是按顺序执行的 action object 列表。

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

`columns` 控制默认 Markdown、table 和 CSV 的字段顺序。JSON 保留完整结果。

```yaml
columns: [title, url, score]
defaultFormat: md
```

`output` 可为需要更明确合同的命令提供 result schema 和 agent hint。

## Schema-v2 必填 metadata

提交到仓库的 YAML adapter 带有六个字段：

| 字段                 | 用途                                       |
| -------------------- | ------------------------------------------ |
| `schema_version: v2` | 选择当前 adapter metadata schema           |
| `capabilities`       | 列出命令使用的 capability                  |
| `minimum_capability` | 执行所需的最小接口                         |
| `trust`              | `public`、`user` 或 `system` 来源          |
| `confidentiality`    | `public`、`internal` 或 `private` 数据类别 |
| `quarantine`         | 标记等待修复的 adapter                     |

给已有 adapter 加入当前 metadata：

```bash
unicli migrate schema-v2 path/to/adapter.yaml --write
```

## TypeScript adapter

SDK integration、streaming protocol、自定义 pagination 和 stateful flow 适合使用 TypeScript。

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

TypeScript registration 直接调用 registry API，因此参数使用 array。

## 验证

```bash
npm run lint:adapters
npm run lint:schema-v2
unicli describe <site> <command>
unicli test <site>
```

Loader 位于 `src/core/yaml-adapter.ts`，v2 metadata schema 位于 `src/core/schema-v2.ts`。
