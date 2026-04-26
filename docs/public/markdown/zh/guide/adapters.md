<!-- 由 docs/zh/guide/adapters.md 生成。不要直接编辑此副本。 -->

# 适配器

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/adapters
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/adapters.md
- 栏目: 指南
- 上级: 指南 (/zh/guide/)

Adapter 把一个站点、桌面应用或工具映射成一组 CLI 命令。Uni-CLI 当前支持五类 adapter，每一类对应不同的软件接口。

## Adapter 类型

| Type      | 面向的接口            | 认证                 | 示例                         |
| --------- | --------------------- | -------------------- | ---------------------------- |
| `web-api` | HTTP API              | 无、Cookie 或 Header | hackernews, reddit, bilibili |
| `browser` | 完整浏览器控制        | Chrome session       | chatgpt, notion, discord     |
| `desktop` | 本地子进程            | 通常无               | ffmpeg, imagemagick, blender |
| `bridge`  | 已安装的 CLI          | 透传                 | gh, docker, vercel, yt-dlp   |
| `service` | WebSocket / HTTP 服务 | API key 或无         | ollama, obs-studio, comfyui  |

## YAML 格式

多数 adapter 是大约 20 行 YAML。没有 imports，没有构建步骤，也没有额外运行时依赖。

```yaml
site: example
name: command-name
type: web-api
strategy: public
pipeline:
  - fetch: { url: "https://api.example.com/data" }
  - select: "items"
  - map: { title: "${{ item.title }}", score: "${{ item.score }}" }
columns: [title, score]
```

字段名和命令名不要翻译，它们是机器合同。中文文档只解释它们的含义。

## `web-api`：HTTP API

最常见的类型。它从 REST API 拉数据，再用 pipeline steps 转成稳定输出。

```yaml
site: hackernews
name: top
description: Top stories from Hacker News
type: web-api
strategy: public
pipeline:
  - fetch:
      url: "https://hacker-news.firebaseio.com/v0/topstories.json"
  - limit: 30
  - each:
      parallel: 10
      pipeline:
        - fetch:
            url: "https://hacker-news.firebaseio.com/v0/item/${{ item }}.json"
  - map:
      title: "${{ item.title }}"
      score: "${{ item.score }}"
      by: "${{ item.by }}"
      url: "${{ item.url }}"
columns: [title, score, by, url]
```

认证型 API 仍然走 `web-api`，只是 `strategy` 变成 `cookie` 或 `header`。Cookie 放在 `~/.unicli/cookies/SITE.json`。

## `browser`：浏览器控制

当站点没有稳定 API，或者页面必须通过真实浏览器交互时，用 `browser`。它通过 Chrome/CDP 做导航、点击、输入、截图、请求拦截和 DOM 快照。

```yaml
site: chatgpt
name: ask
description: Send a prompt to ChatGPT
type: browser
strategy: ui
args:
  - name: prompt
    required: true
    positional: true
pipeline:
  - navigate:
      url: "https://chatgpt.com"
  - wait: "#prompt-textarea"
  - click: "#prompt-textarea"
  - type:
      selector: "#prompt-textarea"
      text: "${{ args.prompt }}"
  - press: Enter
  - wait: 5000
  - snapshot: { interactive: false }
```

## `desktop`：本地软件

`desktop` adapter 调用本地可执行文件。它适合媒体处理、CAD、图像工具、Office automation 等本机能力。

```yaml
site: ffmpeg
name: info
description: Show media file information
type: desktop
binary: ffmpeg
detect: "ffmpeg -version"
args:
  - name: file
    required: true
    positional: true
pipeline:
  - exec:
      command: "ffprobe"
      args:
        [
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          "${{ args.file }}",
        ]
      parse: json
```

如果工具接受脚本文件，用 `write_temp` 先生成临时脚本，再用 `exec` 调用工具。

## `bridge`：外部 CLI

`bridge` 不重新实现已有 CLI。它把 `gh`、`docker`、`yt-dlp` 这类工具挂进统一发现和输出合同里。

适合：

- 工具已经有成熟 CLI。
- 认证、配置、缓存都由原 CLI 管。
- Uni-CLI 只需要提供统一入口和 agent-readable 输出。

## `service`：本地或云服务

`service` 用于 WebSocket、本地 HTTP 服务或云服务。比如本机推理服务、媒体控制服务、UI 自动化服务。

## Args

`args` 是命令输入合同。常见字段：

| 字段          | 含义                          |
| ------------- | ----------------------------- |
| `name`        | 参数名。                      |
| `type`        | `str`、`int`、`bool` 等类型。 |
| `required`    | 是否必填。                    |
| `default`     | 默认值。                      |
| `positional`  | 是否作为位置参数传入。        |
| `description` | 给人和智能体看的说明。        |

示例：

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

## 输出列

`columns` 定义表格/Markdown 输出的默认字段。JSON 输出仍保留完整数据。

```yaml
columns: [title, url, score]
```

## 什么时候用 TypeScript

优先 YAML。只有这些情况才用 TypeScript：

- 需要复杂签名、加密或二进制处理。
- 需要调用 SDK 或处理长状态机。
- pipeline steps 已经不足以表达行为。

TypeScript adapter 也要保持同样的输入、输出和错误合同。

## 验证

```bash
npm run lint:adapters
npm run lint:schema-v2
npm exec vitest run --project adapter
```

如果改了公开能力，还要更新站点目录和文档。
