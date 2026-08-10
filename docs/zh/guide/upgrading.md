---
title: 更新 Uni-CLI
description: 管理 Agent 自动更新、交互式确认、版本检查和包管理器恢复。
---

# 更新 Uni-CLI

Uni-CLI 会在普通命令启动时读取 npm 版本缓存。后台刷新每 24 小时最多运行一次，当前任务不会等待 npm registry。

## 默认更新策略

非交互 Agent 使用持久化的全局安装时，Uni-CLI 默认在后台安装缓存中的准确版本。更新完成以后，下一个 Uni-CLI 进程会使用新版本。

交互式终端保留清晰的 Y/N 选择。源码目录、CI、`npx`、`pnpx` 和 `bunx` 不会自动安装。

下面的命令可以持久修改当前机器的策略。

```bash
unicli upgrade --auto-update
unicli upgrade --no-auto-update
```

`UNICLI_AUTO_UPDATE=0` 会关闭当前环境的自动更新。`UNICLI_AUTO_UPDATE=1` 也会为持久化的交互式安装启用自动更新。环境变量的优先级高于持久化设置。

## 检查已安装版本

```bash
unicli upgrade --check -f json
```

结果包含 `current`、`latest`、`update_available`、检测到的包管理器，以及当前提醒状态。

## 使用 Y 或 N 选择

```bash
unicli upgrade
```

按 `Y` 或 Enter 会安装提示中的准确版本。按 `N` 会继续使用当前版本，并在 24 小时后再次提醒。

下面的命令只隐藏当前提示版本。npm 发布后续版本时，提醒会恢复。

```bash
unicli upgrade --skip-version
```

## Agent 更新信息

已安装版本落后时，JSON、YAML 和 Markdown envelope 会带上 `meta.update`。`automatic_update.status` 会说明后台安装已经排队、正在运行、已经完成、等待重试，或者需要明确选择。

MCP server 会把同一份信息放在 `_meta["io.unicli/update"]` 中。通过 `unicli-mcp` 启动的 server 也使用这套规则。

```json
{
  "meta": {
    "update": {
      "status": "available",
      "current": "1.1.0",
      "latest": "1.1.1",
      "unattended_command": "unicli upgrade --yes",
      "decline_command": "unicli upgrade --no",
      "automatic_update": {
        "enabled": true,
        "status": "scheduled",
        "package_manager": "npm",
        "opt_out": "UNICLI_AUTO_UPDATE=0"
      }
    }
  }
}
```

Agent 仍然可以立即执行前台更新并确认结果。

```bash
unicli upgrade --yes -f json
unicli --version
```

关闭自动更新以后，非交互进程如果没有传入 `--yes`，结果会返回 `confirmation_required`，其中包含确认、延后和跳过当前版本的命令。

## 包管理器与恢复

Uni-CLI 可以识别持久化的全局 npm、pnpm 和 Bun 安装。自动安装和明确执行的安装都会锁定经过校验的准确版本，并且不经过 Shell 启动包管理器。

本地 lease 会阻止多个 Agent 进程同时修改全局安装。失败结果会写入仅当前用户可读的状态文件，并在限定时间后重试。

源码目录和临时执行环境需要明确指定包管理器，或者重新进行全局安装。

```bash
unicli upgrade --yes --package-manager npm
npm install --global @zenalexa/unicli@latest
```

CI 默认关闭后台检查和自动安装。下面的变量会完全关闭版本检查。

```bash
NO_UPDATE_NOTIFIER=1
UNICLI_DISABLE_UPDATE_CHECK=1
```

`UNICLI_UPDATE_CHECK_FORCE=1` 可以在 CI 中执行诊断检查。该变量不会批准安装。
