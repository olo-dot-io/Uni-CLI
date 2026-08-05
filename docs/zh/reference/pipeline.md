---
title: Pipeline steps
description: YAML adapter 可用的 built-in action、常见写法与当前完整 action 列表。
---

# Pipeline steps

YAML pipeline 会把每个 action 的输出传给下一步。Uni-CLI 当前有 <span><!-- STATS:pipeline_step_count -->113<!-- /STATS --></span> 个 built-in action。

其中 <span><!-- STATS:pipeline_registered_step_count -->58<!-- /STATS --></span> 个属于 registered pipeline action。

另外 <span><!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --></span> 个属于 transport-native action。

## 基本结构

```yaml
pipeline:
  - fetch:
      url: https://api.example.com/items
  - select: data.items
  - map:
      title: ${{ item.title }}
      url: ${{ item.url }}
  - limit: ${{ args.limit }}
```

## HTTP 与内容

| Action         | 用途                             |
| -------------- | -------------------------------- |
| `fetch`        | 请求 JSON 或其他结构化 HTTP 响应 |
| `fetch_text`   | 请求原始文字或 HTML              |
| `parse_rss`    | 解析 RSS 或 Atom                 |
| `html_to_md`   | 把 HTML 转为 Markdown            |
| `download`     | 保存远程文件                     |
| `oauth2-token` | 请求并存储 OAuth 2 token         |
| `websocket`    | 通过 WebSocket 交换消息          |

```yaml
- fetch:
    url: https://api.example.com/search
    method: GET
    params:
      q: ${{ args.query }}
    headers:
      Accept: application/json
```

## 数据转换

| Action       | 用途                             |
| ------------ | -------------------------------- |
| `select`     | 从当前值中读取路径               |
| `select-xml` | 从 XML 中选择数据                |
| `extract`    | 从 HTML 或 DOM 提取字段          |
| `map`        | 把 item 映射为新对象             |
| `filter`     | 保留匹配 item                    |
| `sort`       | 排序列表                         |
| `limit`      | 保留前 N 项                      |
| `to_entries` | 把 object 转为 key/value entries |
| `split_text` | 拆分文本                         |
| `set`        | 保存命名值                       |
| `append`     | 向列表追加值                     |
| `assert`     | 验证结果条件                     |

```yaml
- map:
    title: ${{ item.title }}
    author: ${{ item.by }}
- filter: item.title && !item.deleted
- sort:
    by: score
    order: desc
- limit: 10
```

## Control flow

| Action       | 用途                            |
| ------------ | ------------------------------- |
| `if`         | 条件匹配时运行分支              |
| `each`       | 为每个 item 运行 child pipeline |
| `parallel`   | 并发运行独立分支                |
| `rate_limit` | 控制一个域名或资源的节奏        |
| `wait`       | 等待时间或目标条件              |

```yaml
- each:
    parallel: 4
    pipeline:
      - fetch:
          url: https://api.example.com/items/${{ item.id }}
```

## 浏览器

| Action      | 用途                       |
| ----------- | -------------------------- |
| `navigate`  | 打开 URL                   |
| `evaluate`  | 运行页面 JavaScript        |
| `click`     | 点击选中元素               |
| `type`      | 输入文字                   |
| `press`     | 发送按键                   |
| `scroll`    | 滚动页面                   |
| `snapshot`  | 读取页面 snapshot 与 ref   |
| `tap`       | 激活 ref                   |
| `intercept` | 捕获匹配的 browser request |

```yaml
- navigate:
    url: https://example.com
- snapshot:
    interactive: true
- click:
    selector: "#sign-in"
```

## 本地与桌面 orchestration

| Action       | 用途                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| `exec`       | 用 argv array 启动可执行程序                                               |
| `write_temp` | 为后续 action 创建临时文件                                                 |
| `compute_*`  | 通过 compute 路由 snapshot、input、screenshot、assertion 和 session action |

常用 compute action 包括 `compute_snapshot`、`compute_find`、`compute_click`、`compute_type`、`compute_press`、`compute_scroll`、`compute_screenshot`、`compute_assert`、`compute_session_start`、`compute_session_state` 和 `compute_session_end`。

```yaml
- exec:
    command: ffprobe
    args: ["-v", "quiet", "-print_format", "json", ${{ args.file }}]
    parse: json
    timeout: 30000
```

## Registered actions

当前 registered action 名称：

```text
append, assert, click, compute_apps, compute_assert, compute_cdp_attach,
compute_click, compute_drag, compute_evaluate, compute_find, compute_launch,
compute_observe, compute_point_click, compute_point_scroll, compute_press,
compute_screenshot, compute_scroll, compute_session_end,
compute_session_escalate, compute_session_start, compute_session_state,
compute_snapshot, compute_text, compute_type, compute_wait, compute_windows,
download, each, evaluate, exec, extract, fetch, fetch_text, filter,
html_to_md, if, intercept, limit, map, navigate, oauth2-token, parallel,
parse_rss, press, rate_limit, scroll, select, select-xml, set, snapshot,
sort, split_text, tap, to_entries, type, wait, websocket, write_temp
```

## Transport-native actions

Transport adapter 还提供 macOS AX、Windows UIA、Linux AT-SPI、clipboard、application 与 visual action：

```text
applescript, ax_*, uia_*, atspi_*, clipboard_read, clipboard_write,
focus_window, launch_app, visual_*
```

这些 action 通过选中的 transport provider 与 capability row 执行。`src/engine/step-surface.ts` 会从 step registry 和 transport handler table 推导完整列表。

## 模板

| 表达式              | 值             |
| ------------------- | -------------- |
| `${{ args.name }}`  | 命令参数       |
| `${{ item.field }}` | 当前 item 字段 |
| `${{ index }}`      | 当前列表 index |
| `${{ env.NAME }}`   | 环境变量       |

Step schema 与实现在 `src/engine/steps/` 中。修改 pipeline 后运行 `npm run lint:adapters`。
