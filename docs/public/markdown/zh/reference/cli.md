<!-- 由 docs/zh/reference/cli.md 生成。不要直接编辑此副本。 -->

# CLI 命令

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/reference/cli
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/reference/cli.md
- 栏目: 参考
- 上级: 参考 (/zh/reference/)

根命令按发现、执行、恢复和控制面组织。

## 发现

| 命令                                      | 用途                   |
| ----------------------------------------- | ---------------------- |
| `unicli search "<意图>"`                  | 按自然语言意图排序操作 |
| `unicli list`                             | 列出已安装站点和命令   |
| `unicli list --site <site>`               | 列出一个站点的命令     |
| `unicli describe <site> <command>`        | 查看参数和示例         |
| `unicli describe <site> <command> --full` | 查看完整操作合同       |

用 `unicli help <command>` 查看某个命令的参数。

## 执行

```bash
unicli <site> <command> [options]
```

可以使用以下全局输出格式。

```text
-f json
-f yaml
-f csv
-f md
-f compact
```

`--dry-run` 会预览参数解析和选中的 pipeline。

## 更新

| 命令                                         | 用途                     |
| -------------------------------------------- | ------------------------ |
| `unicli upgrade --check -f json`             | 比较已安装版本和可用版本 |
| `unicli upgrade`                             | 打开交互式 Y/N 选择      |
| `unicli upgrade --yes`                       | 免交互安装               |
| `unicli upgrade --no`                        | 24 小时后再次提醒        |
| `unicli upgrade --skip-version`              | 隐藏当前提示版本         |
| `unicli upgrade --auto-update`               | 为当前机器启用自动更新   |
| `unicli upgrade --no-auto-update`            | 要求明确确认             |
| `unicli upgrade --package-manager <manager>` | 指定 npm、pnpm 或 Bun    |

Agent metadata 和安装边界见[更新 Uni-CLI](/zh/guide/upgrading)。

## 登录与认证

| 命令                                         | 用途                       |
| -------------------------------------------- | -------------------------- |
| `unicli auth setup <site>`                   | 显示站点需要的凭据         |
| `unicli auth import <site> --browser chrome` | 导入一个站点的浏览器登录态 |
| `unicli auth check <site>`                   | 验证已保存凭据             |
| `unicli auth list`                           | 列出已配置站点             |
| `unicli doctor cookies`                      | 诊断浏览器 cookie 读取     |

## 浏览器

| 命令                                | 用途                                   |
| ----------------------------------- | -------------------------------------- |
| `unicli browser doctor --json`      | 查看浏览器、profile、broker 和策略状态 |
| `unicli browser profiles --json`    | 列出本机 Chromium profile              |
| `unicli browser start`              | 启动 managed provider                  |
| `unicli browser --background start` | 在后台使用已有 Chrome                  |
| `unicli browser --focus start`      | 在前台使用已有 Chrome                  |
| `unicli browser state -f json`      | 读取 accessible page state             |
| `unicli browser screenshot <path>`  | 截取当前页面                           |

完整 action 见 `unicli help browser`。

## 桌面

| 命令                                            | 用途              |
| ----------------------------------------------- | ----------------- |
| `unicli doctor compute -f json`                 | 检查桌面 provider |
| `unicli compute snapshot --app <name>`          | 读取应用 snapshot |
| `unicli compute click <ref> --app <name>`       | 激活元素          |
| `unicli compute type <ref> <text> --app <name>` | 输入文字          |

## 修复与开发

| 命令                                       | 用途                   |
| ------------------------------------------ | ---------------------- |
| `unicli repair <site> <command> --dry-run` | 预览验证               |
| `unicli repair <site> <command>`           | 验证更新后的 adapter   |
| `unicli init <site> <command>`             | 创建 YAML adapter      |
| `unicli dev <path>`                        | 开发时重新加载 adapter |
| `unicli test <site>`                       | 运行 adapter 检查      |

## Run evidence 与 evolution

| 命令                                                               | 用途                                          |
| ------------------------------------------------------------------ | --------------------------------------------- |
| `unicli runs list`                                                 | 列出本地 recorded run                         |
| `unicli runs distill <run_ids...>`                                 | 生成经过脱敏的 evidence packet                |
| `unicli evolve adapter <site> <command>`                           | 创建隔离的 YAML adapter draft                 |
| `unicli evolve adapter <site> <command> --candidate ... --promote` | 验证并按 gate 结果晋级 candidate              |
| `unicli evolve verify <session_id> [--promote]`                    | 追加 attempt，或晋级未变化的 verified attempt |
| `unicli evolve inspect [session_id]`                               | 列出 session 或检查一个 session               |
| `unicli evolve rollback <session_id>`                              | 恢复 promotion 前的精确 user overlay          |

Proposal run 只为 Agent 提供 evidence，不能同时充当 validation 或 held-out run。发生变化的 candidate 必须声明可证伪 hypothesis 和预期修复项。Candidate 还需要在没有 regression 的情况下提升 validation，保持 held-out behavior，并保留 baseline operation contract。每个经过 review 的替换 network origin 都需要在创建 session 时通过 `--allow-origin <origin>` 声明。调用方只有显式传入 `--allow-mutation-eval` 才能评估 mutating operation。

## Plugin

| 命令                           | 用途                                                      |
| ------------------------------ | --------------------------------------------------------- |
| `unicli plugin inspect <path>` | 验证 Agent Plugins 1.0 package 并显示 runtime projection  |
| `unicli plugin create <name>`  | 创建 portable Skill 与 Uni-CLI runtime extension scaffold |
| `unicli plugin list`           | 列出已安装的 portable 与 native plugin                    |

## 协议服务

| 命令                        | 用途                          |
| --------------------------- | ----------------------------- |
| `unicli mcp serve`          | 启动 MCP server               |
| `unicli mcp health -f json` | 查看 MCP profile 与 tool 数量 |
| `unicli acp serve`          | 启动 ACP server               |
