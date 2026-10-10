---
title: CLI 命令
description: Uni-CLI 的发现、执行、认证、浏览器、修复和协议服务命令。
---

# CLI 命令

根命令按查找操作、执行任务、失败恢复和界面控制组织。

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

`--dry-run` 预览解析后的参数和选中的流水线。

## 互联网资料

`retrieval search` 返回排序后的来源记录，`extract` 把单个 URL 读取为有界证据文档，`retrieval acquire` 将选中的资料保存到本地，包括原件和结构化文本。

```bash
unicli retrieval search "graph databases" --sources dblp,arxiv --limit 5 -f json
unicli extract https://example.com --max-chars 12000 -f json
unicli retrieval acquire "graph databases" --limit 5 --dir ./research -f json
unicli retrieval acquire --resume ./research/results.json -f json
```

`--max-resources` 限制额外文件链接，`--max-bytes` 限制单个原件大小，`--refresh true` 重新获取已完成资源。结果字段、部分失败与恢复行为见[Agent 互联网访问](../guide/internet-access)。

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

Agent 更新信息和安装规则见[更新 Uni-CLI](../guide/upgrading)。

## 登录与认证

| 命令                                         | 用途                       |
| -------------------------------------------- | -------------------------- |
| `unicli auth setup <site>`                   | 显示站点需要的凭据         |
| `unicli auth import <site> --browser chrome` | 导入一个站点的浏览器登录态 |
| `unicli auth check <site>`                   | 验证已保存凭据             |
| `unicli auth list`                           | 列出已配置站点             |
| `unicli doctor cookies`                      | 诊断浏览器 cookie 读取     |

通过 `auth import <site> --profile-id <id>` 选择本地身份。`auth check` 检查本地凭据文件，原站点命令确认远端是否接受凭据。声明 cookie 的 HTTP 只读命令在认证失败后可以刷新一次，`--no-auth-retry` 关闭恢复。配置优先级、Windows 连接导入和浏览器回合恢复见[登录与认证](../guide/authentication)。

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

完整动作列表见 `unicli help browser`。

## 桌面

| 命令                                            | 用途              |
| ----------------------------------------------- | ----------------- |
| `unicli doctor compute --json`                  | 检查桌面 provider |
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

## 执行记录与适配器演进

| 命令                                                               | 用途                                          |
| ------------------------------------------------------------------ | --------------------------------------------- |
| `unicli runs list`                                                 | 列出本地 recorded run                         |
| `unicli runs distill <run_ids...>`                                 | 生成经过脱敏的 evidence packet                |
| `unicli evolve adapter <site> <command>`                           | 创建隔离的 YAML adapter draft                 |
| `unicli evolve adapter <site> <command> --candidate ... --promote` | 验证并按 gate 结果晋级 candidate              |
| `unicli evolve verify <session_id> [--promote]`                    | 追加 attempt，或晋级未变化的 verified attempt |
| `unicli evolve inspect [session_id]`                               | 列出 session 或检查一个 session               |
| `unicli evolve rollback <session_id>`                              | 恢复 promotion 前的精确 user overlay          |

用于提出修改的执行记录只提供修改依据，与验证记录和保留测试记录分开。候选实现发生变化时，必须声明可证伪的假设和预期修复项。候选实现需要提升验证结果，保持已有用例及保留测试的行为，并保留基线操作契约。每个经过审查的替换网络来源都需要在创建会话时通过 `--allow-origin <origin>` 声明。评估可能改变外部状态的操作还需要显式传入 `--allow-mutation-eval`。

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
