---
title: 登录与认证
description: 配置站点凭据、导入浏览器登录态，并诊断认证状态。
---

# 登录与认证

操作需要 cookie 时，Uni-CLI 可以复用选定浏览器配置中的登录态。公开请求先匿名访问，API 密钥和请求头凭据遵循各适配器声明的要求，浏览器操作使用选中的会话。

## 先运行目标操作

先运行需要的命令。对于声明 cookie 认证的 HTTP 只读操作，Uni-CLI 优先使用可用的已保存凭据，随后读取选定的浏览器配置。来源返回 `auth_required` 或 `challenge_required` 时，运行时会刷新声明的凭据并重试一次。CLI、MCP、ACP 和 hub 共用这条恢复路径。

需要查看凭据要求时，运行错误结果提供的设置命令。

```bash
unicli auth setup <site>
```

结果列出需要的 cookie 名称、连接策略和显式保存时使用的位置。在目标浏览器配置中登录站点，再重新运行原操作。

## 选择浏览器身份

列出本机浏览器配置。

```bash
unicli browser profiles --json
```

本机存在多个配置时，选择已经登录目标账号的配置。复制结果中的 profile ID，将它设置到 Agent 主机使用的环境中。

```bash
export UNICLI_BROWSER_PROFILE_ID="<profile-id>"
```

选择顺序为显式 profile ID、本次托管调用绑定的 profile ID、`UNICLI_BROWSER_PROFILE_ID`。原生 Chrome 和远程连接保持自身身份，不会推导出本地配置。只发现一个配置时可以自动选择。多个配置且尚未指定身份时，命令返回歧义错误，由调用方明确选择账号。

## 显式保存登录态

常规凭据获取将浏览器值保留在内存中。需要让后续命令直接使用已保存凭据时，运行 `auth import`。

```bash
unicli auth import <site> --profile-id <profile-id>
```

也可以继续按浏览器名称导入。

```bash
unicli auth import <site> --browser chrome
```

同一浏览器存在多个配置时，用 `--profile <name>` 指定配置目录名。每次导入选择一种身份方式。`--profile-id`、`--browser` 配合 `--profile`，以及 `--cdp` 分别表示不同来源。

导入后检查保存的文件。

```bash
unicli auth check <site>
```

`auth check` 检查文件是否包含可用值及必需字段。继续运行原站点命令，确认远端服务接受这些凭据。

查看已保存凭据的站点。

```bash
unicli auth list
```

## 浏览器操作与 Windows cookie 导入

浏览器操作通过自己选定的会话读取页面和执行动作。先检查浏览器状态。

```bash
unicli browser doctor --json
```

在后台操作已有 Chrome 配置时，选择后台模式。

```bash
unicli browser --background start
```

需要可见的前台控制时，显式选择焦点模式。

```bash
unicli browser --focus start
```

Windows 上的 Chrome v20 cookie 需要通过浏览器 API 读取。按 doctor 指引安装并连接浏览器扩展与原生宿主，再显式选择连接导入。

```bash
unicli auth import <site> --cdp
```

独立运行的 Windows `auth import --cdp` 使用后台 Chrome/native 连接。macOS 的独立调用使用托管隐藏浏览器，常规本地登录态通过 `--profile-id` 导入。一个 CLI 进程中启动的浏览器不会自动绑定到另一个 `auth import` 进程。自动读取本地配置时始终保持所选身份。

浏览器命令还可以限定预期域名和路径，使操作保持在目标页面上。

## 控制自动恢复

声明 cookie 认证的 HTTP 只读操作在确认认证失败后刷新一次凭据。需要关闭本次自动凭据恢复时，加上 `--no-auth-retry`。网络错误与 HTTP 状态码重试使用各自的策略。

```bash
unicli --no-auth-retry <site> <command> -f json
```

HTTP 写操作需要显式传入 `--auth-retry`，才能在确认认证失败时刷新凭据并重试一次。结果为 `operation_outcome_ambiguous` 时，先检查资源状态，再决定是否重复写入。

浏览器操作使用自身的回合生命周期。认证失败后先完成所需登录，再开始新的操作。共享 HTTP 凭据恢复不会重放已经结束的浏览器回合。

读取普通 URL 时，`extract` 和 `web read` 先匿名请求。目标域名的凭据获取以 401、403 或验证页响应为触发条件。读取器随后可以尝试已保存 cookie 和新获取的浏览器 cookie，认证尝试最多分为这三个阶段。`--no-auth-retry` 关闭自动 cookie 获取与恢复。显式第三方读取器接收 URL，来源站点的 cookie 不会被转发给第三方。

## 存储位置与有效范围

显式导入的凭据按站点保存在 `~/.unicli/cookies/`，文件格式为明文 JSON。macOS 和 Linux 使用目录权限 `0700`、文件权限 `0600`，Windows 使用所在路径的 ACL。将凭据文件排除在版本控制之外，保存的登录态失效时通过 `auth import` 重新导入。

自动获取的浏览器 cookie 只在本次调用的内存中使用。自动刷新不会改写已保存的站点文件。诊断结果说明所选凭据来源，不输出凭据值。

## 诊断登录问题

```bash
unicli auth check <site>
unicli doctor cookies
unicli browser doctor --json
```

先阅读凭据错误，再按 browser doctor 的 `checks[].next_step` 继续。它会根据本机浏览器、配置、broker 状态和管理策略给出下一步。空配置需要先登录，歧义选择需要明确 profile ID，验证页需要完成来源声明的浏览器或 API 流程后再运行原操作。
