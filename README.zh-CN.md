<p align="center">
  <img src="assets/mascot-otter.png" alt="Uni-CLI 水獭吉祥物" width="112">
</p>

<h1 align="center">Uni-CLI</h1>

<p align="center">
  <strong>把所有界面交给 Agent</strong><br>
  安装一次。搜索、执行、检查、修复。
</p>

<p align="center">
  <a href="https://olo-dot-io.github.io/Uni-CLI/zh/">网站</a>&nbsp;&nbsp;
  <a href="https://olo-dot-io.github.io/Uni-CLI/zh/reference/sites">Operation 目录</a>&nbsp;&nbsp;
  <a href="https://www.npmjs.com/package/@zenalexa/unicli">npm</a>&nbsp;&nbsp;
  <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@zenalexa/unicli"><img alt="npm 版本" src="https://img.shields.io/npm/v/@zenalexa/unicli?style=flat-square&color=0A6244"></a>
  <a href="./LICENSE"><img alt="Apache 2.0 许可证" src="https://img.shields.io/badge/license-Apache--2.0-073F2B?style=flat-square"></a>
  <img alt="Node 22.19 或更高版本" src="https://img.shields.io/badge/node-22.19%2B-D86A35?style=flat-square">
</p>

<p align="center">
  <img src="docs/public/site-preview.webp" alt="Uni-CLI 绿色天文台首页，支持一键复制 npm 命令与 Agent 指令" width="100%">
</p>

Uni-CLI 为使用者和 Agent 提供统一命令接口，覆盖网站、浏览器、桌面应用、本地工具与 MCP。描述任务、检查选中的操作，再运行命令，获取结构化数据或可执行的错误建议。

```bash
npm install -g @zenalexa/unicli
unicli search "列出 Hacker News 热门文章"
unicli hackernews top --limit 3 -f json
```

检查后续版本，或者打开 Y/N 更新选择。

```bash
unicli upgrade --check -f json
unicli upgrade
```

持久化安装由非交互 Agent 使用时，Uni-CLI 默认在后台更新。结构化结果通过 `meta.update.automatic_update` 报告进度。交互式终端继续使用 Y/N，`unicli upgrade --no-auto-update` 可以把当前机器改回明确确认。

## Agent 互联网访问

先找到来源，再搜索记录，并在网站支持时直接读取原生 Markdown。学术检索保留明确指定的来源，HTTP 响应提供重试和验证说明。OpenRouter 的模型搜索与分页由服务端完成。

行为、实测结果与来源限制见[访问指南](docs/zh/guide/internet-access.md)和[可复现基准](docs/zh/BENCHMARK.md)。

## 按任务选择路径

操作目录说明可用命令及其参数。执行时使用声明的接口，并把动作限定在目标范围内。每次调用运行一个提供方，失败结果保留原始原因和修复命令。

| 任务边界                 | Execution operator  | 原因                                     |
| ------------------------ | ------------------- | ---------------------------------------- |
| 公开数据或稳定服务合同   | Structured API      | 保留 typed fields、认证姿态和来源        |
| 文件、系统状态、本地工具 | Local runtime       | 直接跨越进程和 OS 边界，不引入浏览器状态 |
| 需要登录态或私有网络合同 | Browser protocol    | 使用明确的 profile、Cookie 或网络合同    |
| 只有页面界面的网页流程   | Semantic browser    | 通过 DOM 与 CDP 语义操作明确目标和会话   |
| 原生桌面应用             | Accessibility       | 使用 AX、UIA 或 AT-SPI 结构化控件树      |
| 像素级或无结构界面       | Visual computer use | 缺少更强接口时使用坐标和视觉 observation |

```bash
unicli search "导出我的收藏内容"        # 发现和排序
unicli list --site reddit                # 检查一个 surface
unicli browser doctor --json             # 检查浏览器 delivery 状态
unicli repair reddit saved               # 验证受支持的漂移路径
```

## 操作契约

每条操作说明接受什么参数、在哪里执行，以及可能改变什么。传入参数或批准执行前，先查看这些信息。

```text
intent → candidate operations → explicit selection → policy → substrate → receipt
```

| 阶段     | Runtime 行为                                                         |
| -------- | -------------------------------------------------------------------- |
| Discover | 编译意图与双语检索返回一组带选择依据的小型候选集                     |
| Select   | 调用方选择一条声明了 strategy 和 substrate 的 operation              |
| Govern   | `open`、`confirm`、`locked` profile 检查 effect 和 capability scope  |
| Act      | 执行选中的 adapter、core command、browser、desktop 或 protocol 路径  |
| Observe  | 每条普通命令返回稳定的成功或错误 envelope                            |
| Repair   | Owned drift path 给出源文件、失败边界和有界验证命令                  |
| Evolve   | Recorded failure 生成隔离 candidate，通过成对和 held-out eval 后晋级 |

Uni-CLI 负责接口运行时。模型、规划器、Agent 执行循环和沙箱均可独立选择。

## 支持的操作范围

| Surface   | 当前 Runtime                                                                     |
| --------- | -------------------------------------------------------------------------------- |
| Web       | 公开数据、Cookie、header、下载、上传、发布、搜索和中文平台                       |
| Browser   | CDP 导航、语义动作、网络、snapshot、截图和执行后证据                             |
| Desktop   | 原生控件、macOS 服务、设计工具、Office 和媒体应用                                |
| Local     | subprocess bridge、文件、PDF 与论文流程、媒体转换和开发者 CLI                    |
| Protocols | Native CLI、MCP stdio、MCP Streamable HTTP、ACP、生成配置和 Agent skills         |
| Policy    | Permission profiles、deny rules、scoped approvals、recording、replay 和 evidence |

静态目录

- <!-- STATS:site_count -->338<!-- /STATS --> 个站点
- <!-- STATS:command_count -->1893<!-- /STATS --> 条注册命令
- <!-- STATS:adapter_count_total -->1267<!-- /STATS --> 个 adapters
- <!-- STATS:pipeline_step_count -->113<!-- /STATS --> 个 pipeline actions
- <!-- STATS:test_count -->10374<!-- /STATS --> 个测试

固定核心命令和本机发现的命令会在运行时加入。

<!-- BEGIN README_SITE_GRID -->
<!-- prettier-ignore -->
| 类别 | 站点 | Operations | 示例 |
| --- | ---: | ---: | --- |
| 社交 | 33 | 396 | [twitter](https://olo-dot-io.github.io/Uni-CLI/reference/sites#twitter), [zhihu](https://olo-dot-io.github.io/Uni-CLI/reference/sites#zhihu), [instagram](https://olo-dot-io.github.io/Uni-CLI/reference/sites#instagram), [reddit](https://olo-dot-io.github.io/Uni-CLI/reference/sites#reddit) |
| 视频 | 8 | 75 | [tiktok](https://olo-dot-io.github.io/Uni-CLI/reference/sites#tiktok), [youtube](https://olo-dot-io.github.io/Uni-CLI/reference/sites#youtube), [bilibili](https://olo-dot-io.github.io/Uni-CLI/reference/sites#bilibili), [douyin](https://olo-dot-io.github.io/Uni-CLI/reference/sites#douyin) |
| 新闻 | 11 | 45 | [hackernews](https://olo-dot-io.github.io/Uni-CLI/reference/sites#hackernews), [bloomberg](https://olo-dot-io.github.io/Uni-CLI/reference/sites#bloomberg), [bbc](https://olo-dot-io.github.io/Uni-CLI/reference/sites#bbc), [36kr](https://olo-dot-io.github.io/Uni-CLI/reference/sites#36kr) |
| 财经 | 10 | 67 | [eastmoney](https://olo-dot-io.github.io/Uni-CLI/reference/sites#eastmoney), [xueqiu](https://olo-dot-io.github.io/Uni-CLI/reference/sites#xueqiu), [binance](https://olo-dot-io.github.io/Uni-CLI/reference/sites#binance), [coingecko](https://olo-dot-io.github.io/Uni-CLI/reference/sites#coingecko) |
| 购物 | 13 | 47 | [amazon](https://olo-dot-io.github.io/Uni-CLI/reference/sites#amazon), [jd](https://olo-dot-io.github.io/Uni-CLI/reference/sites#jd), [taobao](https://olo-dot-io.github.io/Uni-CLI/reference/sites#taobao), [1688](https://olo-dot-io.github.io/Uni-CLI/reference/sites#1688) |
| 开发 | 37 | 185 | [codex](https://olo-dot-io.github.io/Uni-CLI/reference/sites#codex), [cursor](https://olo-dot-io.github.io/Uni-CLI/reference/sites#cursor), [gh](https://olo-dot-io.github.io/Uni-CLI/reference/sites#gh), [stackoverflow](https://olo-dot-io.github.io/Uni-CLI/reference/sites#stackoverflow) |
| AI | 25 | 216 | [chatgpt](https://olo-dot-io.github.io/Uni-CLI/reference/sites#chatgpt), [antigravity](https://olo-dot-io.github.io/Uni-CLI/reference/sites#antigravity), [chatwise](https://olo-dot-io.github.io/Uni-CLI/reference/sites#chatwise), [notebooklm](https://olo-dot-io.github.io/Uni-CLI/reference/sites#notebooklm) |
| 学术 | 30 | 105 | [openreview](https://olo-dot-io.github.io/Uni-CLI/reference/sites#openreview), [zotero](https://olo-dot-io.github.io/Uni-CLI/reference/sites#zotero), [pubmed](https://olo-dot-io.github.io/Uni-CLI/reference/sites#pubmed), [arxiv](https://olo-dot-io.github.io/Uni-CLI/reference/sites#arxiv) |
| 专利 | 17 | 42 | [epo](https://olo-dot-io.github.io/Uni-CLI/reference/sites#epo), [espacenet](https://olo-dot-io.github.io/Uni-CLI/reference/sites#espacenet), [cipo](https://olo-dot-io.github.io/Uni-CLI/reference/sites#cipo), [cnipa](https://olo-dot-io.github.io/Uni-CLI/reference/sites#cnipa) |
| 知识 | 12 | 47 | [marxists-cn](https://olo-dot-io.github.io/Uni-CLI/reference/sites#marxists-cn), [anilist](https://olo-dot-io.github.io/Uni-CLI/reference/sites#anilist), [bangumi](https://olo-dot-io.github.io/Uni-CLI/reference/sites#bangumi), [imdb](https://olo-dot-io.github.io/Uni-CLI/reference/sites#imdb) |
| 音频 | 4 | 46 | [spotify](https://olo-dot-io.github.io/Uni-CLI/reference/sites#spotify), [netease-music](https://olo-dot-io.github.io/Uni-CLI/reference/sites#netease-music), [xiaoyuzhou](https://olo-dot-io.github.io/Uni-CLI/reference/sites#xiaoyuzhou), [apple-podcasts](https://olo-dot-io.github.io/Uni-CLI/reference/sites#apple-podcasts) |
| 内容 | 16 | 90 | [lesswrong](https://olo-dot-io.github.io/Uni-CLI/reference/sites#lesswrong), [danbooru](https://olo-dot-io.github.io/Uni-CLI/reference/sites#danbooru), [dlsite](https://olo-dot-io.github.io/Uni-CLI/reference/sites#dlsite), [weread](https://olo-dot-io.github.io/Uni-CLI/reference/sites#weread) |
| 效率 | 10 | 78 | [notion-app](https://olo-dot-io.github.io/Uni-CLI/reference/sites#notion-app), [ones](https://olo-dot-io.github.io/Uni-CLI/reference/sites#ones), [obsidian](https://olo-dot-io.github.io/Uni-CLI/reference/sites#obsidian), [quark](https://olo-dot-io.github.io/Uni-CLI/reference/sites#quark) |
| 招聘 | 6 | 42 | [nowcoder](https://olo-dot-io.github.io/Uni-CLI/reference/sites#nowcoder), [boss](https://olo-dot-io.github.io/Uni-CLI/reference/sites#boss), [51job](https://olo-dot-io.github.io/Uni-CLI/reference/sites#51job), [linkedin](https://olo-dot-io.github.io/Uni-CLI/reference/sites#linkedin) |
| 桌面 | 25 | 201 | [macos](https://olo-dot-io.github.io/Uni-CLI/reference/sites#macos), [freecad](https://olo-dot-io.github.io/Uni-CLI/reference/sites#freecad), [blender](https://olo-dot-io.github.io/Uni-CLI/reference/sites#blender), [gimp](https://olo-dot-io.github.io/Uni-CLI/reference/sites#gimp) |
| 游戏 | 1 | 7 | [steam](https://olo-dot-io.github.io/Uni-CLI/reference/sites#steam) |
| 工具 | 7 | 29 | [linear](https://olo-dot-io.github.io/Uni-CLI/reference/sites#linear), [bitwarden](https://olo-dot-io.github.io/Uni-CLI/reference/sites#bitwarden), [todoist](https://olo-dot-io.github.io/Uni-CLI/reference/sites#todoist), [qweather](https://olo-dot-io.github.io/Uni-CLI/reference/sites#qweather) |
| 其他 | 72 | 124 | [slay-the-spire-ii](https://olo-dot-io.github.io/Uni-CLI/reference/sites#slay-the-spire-ii), [xiaoe](https://olo-dot-io.github.io/Uni-CLI/reference/sites#xiaoe), [archive](https://olo-dot-io.github.io/Uni-CLI/reference/sites#archive), [ke](https://olo-dot-io.github.io/Uni-CLI/reference/sites#ke) |
| 旅行 | 1 | 4 | [ctrip](https://olo-dot-io.github.io/Uni-CLI/reference/sites#ctrip) |

<!-- END README_SITE_GRID -->

生成的 [Operation 目录](https://olo-dot-io.github.io/Uni-CLI/zh/reference/sites) 是权威清单。

## 接入 Agent

### Native CLI

```bash
unicli search "下载最新的 computer use 论文" -f json
unicli arxiv search "computer use agents" --limit 5 -f json
unicli --auth-retry openreview conference "ICML.cc/2026/Conference" --rpm 20 -f json
unicli extract https://example.com --max-chars 1200
```

管道输出默认使用 Markdown。后续步骤需要稳定机器格式时，可以选择 `-f json`、`yaml`、`csv` 或 `compact`。[OpenReview 归档指南](https://olo-dot-io.github.io/Uni-CLI/zh/guide/openreview-archive) 说明如何使用登录态建立可续传的会议和跨年度研究归档。

### MCP

```json
{
  "mcpServers": {
    "unicli": {
      "command": "npx",
      "args": ["-y", "@zenalexa/unicli-mcp"]
    }
  }
}
```

等价命令

```bash
npx -y @zenalexa/unicli mcp serve
```

默认配置提供 4 个元工具。客户端需要逐个发现工具时，可以使用 deferred 或 expanded 配置。运行 `unicli mcp health -f json` 查看当前暴露的工具。

### 本地计算机

```bash
unicli compute apps --format compact
unicli compute snapshot --app Calculator --format compact
unicli compute find --app Calculator --role AXButton --title "7"
unicli compute click --ref <ref-from-find>
```

桌面操作优先使用无障碍元素引用。像素操作需要明确选择已配置的后端，常规操作失败时不会自动切换到像素控制。

## 能解释自身的结果

成功

```yaml
ok: true
schema_version: "2"
command: "hackernews.top"
meta:
  duration_ms: 412
  count: 3
  surface: web
data:
  - { rank: "1", title: "...", url: "...", author: "..." }
error: null
```

失败

```yaml
ok: false
schema_version: "2"
command: "reddit.saved"
data: null
error:
  code: auth_required
  adapter_path: "src/adapters/reddit/saved.yaml"
  step: 1
  suggestion: "Run: unicli auth setup reddit"
  retryable: false
```

Exit code 区分成功、空结果、依赖不可用、临时失败、认证和配置问题。详见 [输出和 exit code 参考](docs/reference/exit-codes.md)。

## 定位并修复失效操作

根据错误中的源文件路径查看失效操作。开发修复时，可以用本地适配器覆盖包内版本。

```text
run → read error.adapter_path → patch the owned step → save override → verify once
```

```bash
unicli repair <site> <command>
```

`repair` 通过有时限的子进程重新运行原命令，验证成功的条件是目标返回 `ok: true` 且退出码为 `0`。源文件和 Git 状态保持原样。`~/.unicli/adapters/` 中的本地覆盖版本会在 npm 更新后保留。

同类失败重复出现时，使用 `evolve adapter` 分开保存修改依据、验证用例和保留测试用例。Agent 提交一份隔离的 YAML 候选实现及可证伪的预测。Uni-CLI 成对评估基线与候选实现，记录预测遗漏和退化，通过晋级条件后才安装用户覆盖版本。

```bash
unicli evolve adapter <site> <command> \
  --run <proposal-run> \
  --candidate <candidate.yaml> \
  --hypothesis "<expected mechanism>" \
  --expect <validation-case-id> \
  --risk <held-out-case-id> \
  --validation <validation-eval.yaml> \
  --held-out <held-out-eval.yaml> \
  --promote
```

省略 `--candidate` 时，命令会创建可编辑草稿。每次验证都会把候选快照、补丁和报告保存为经过哈希校验的独立记录。候选实现未变化时，`evolve verify --promote` 复用最新的合格记录。晋级与回滚可以在写入中断后继续，多个 Agent 进程的竞争操作会串行执行。`evolve inspect` 返回完整尝试历史并报告损坏的会话，`evolve rollback` 精确恢复晋级前的覆盖版本。

演进范围固定操作身份、输入输出契约、流水线动作结构、请求方法和请求头，以及已有子进程调用。可以修改同一来源内的端点和内容提取逻辑。替换网络来源时，创建会话的命令必须显式传入 `--allow-origin <origin>`。

下面是一份最小 YAML 适配器。

```yaml
site: example
name: search
description: Search example.com
transport: http
strategy: public
pipeline:
  - fetch: { url: "https://api.example.com/search?q=${{ args.query }}" }
  - select: data.results
  - map: { title: "${{ item.title }}", url: "${{ item.url }}" }
  - limit: "${{ args.limit }}"
args:
  - { name: query, type: string, required: true, positional: true }
  - { name: limit, type: int, default: 20 }
columns: [title, url]
```

继续阅读 [Adapter 格式](docs/ADAPTER-FORMAT.md)、[Pipeline 参考](docs/reference/pipeline.md) 和 [自修复指南](docs/zh/guide/self-repair.md)。

## 信任边界

- 浏览器 cookie 默认保存在进程内存，`auth import` 和 `browser cookies` 提供显式持久化入口。
- 浏览器自动化使用 `~/.unicli/` 下由 Uni-CLI 管理的配置。Chrome 136+ 要求远程调试使用独立用户数据目录。
- `unicli browser doctor --json` 返回可用的连接路径和修复命令，检查过程保持只读。
- 浏览器、文件、剪贴板、子进程和桌面操作在产生副作用前检查权限。格式错误的显式策略会中止授权。
- 视觉操作需要已配置的后端，缺少服务时返回结构化错误。
- 调用诊断只保留运行元数据，参数、内容、URL、凭据和原始错误排除在外。`UNICLI_NO_LOG=1` 可以关闭新增事件。

凭据选择、存储路径和失败恢复见[登录与认证](docs/zh/guide/authentication.md)，浏览器可见性与桌面控制见[浏览器与桌面](docs/zh/guide/browser-desktop.md)。

## 开发

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run verify   # 完整 E2E 与 adapter coverage；发布前必须运行
```

需要 Node.js 22.19 或更高版本。适配器和引擎的开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

全部已发布版本见[生成的版本记录](docs/zh/releases.md)。Agent 可以通过 `docs/public/release-history.json` 读取同一份结构化数据。

<p align="center"><sub>v1.3.0 — Artemis · Rubins</sub></p>

## License

Apache-2.0
