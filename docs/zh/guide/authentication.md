---
title: 登录与认证
description: 配置站点凭据、导入浏览器登录态，并诊断认证状态。
---

# 登录与认证

每条操作都声明自己的连接方式。公开操作可直接运行；cookie 和 header 操作读取站点凭据；浏览器操作使用 managed browser 或已有浏览器 session。

## 从错误结果开始

先运行一次操作。需要登录时，Uni-CLI 会返回 `auth_required` 和对应的设置命令。

```bash
unicli auth setup <site>
```

该命令会显示 adapter 需要的字段及读取位置。

## 导入浏览器登录态

列出本机浏览器 profile：

```bash
unicli browser profiles --json
```

从指定浏览器导入：

```bash
unicli auth import <site> --browser chrome
```

检查保存后的凭据：

```bash
unicli auth check <site>
```

查看当前用户已配置的站点：

```bash
unicli auth list
```

## 使用实时浏览器 session

先读取浏览器健康状态：

```bash
unicli browser doctor --json
```

在后台使用已有 Chrome profile：

```bash
unicli browser --background start
```

需要可见的前台控制时：

```bash
unicli browser --focus start
```

浏览器命令还可以限定预期域名和路径，让操作保持在目标页面上。

## 凭据位置

显式导入的站点凭据按站点保存到 `~/.unicli/cookies/`。实时值留在当前浏览器 session 中。诊断输出会标明本次选择的来源。

## 诊断登录问题

```bash
unicli auth check <site>
unicli doctor cookies
unicli browser doctor --json
```

按 browser doctor 返回的 `checks[].next_step` 继续。它会根据本机浏览器、profile、broker 状态和管理策略给出下一条命令。
