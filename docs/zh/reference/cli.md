---
title: CLI 命令
description: Uni-CLI 的发现、执行、认证、浏览器、修复和协议服务命令。
---

# CLI 命令

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

全局输出格式：

```text
-f json
-f yaml
-f csv
-f md
-f compact
```

`--dry-run` 会预览参数解析和选中的 pipeline。

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

## 协议服务

| 命令                        | 用途                          |
| --------------------------- | ----------------------------- |
| `unicli mcp serve`          | 启动 MCP server               |
| `unicli mcp health -f json` | 查看 MCP profile 与 tool 数量 |
| `unicli acp serve`          | 启动 ACP server               |
