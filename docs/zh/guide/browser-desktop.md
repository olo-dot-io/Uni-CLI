---
title: 浏览器与桌面
description: 选择浏览器 session，读取页面状态，并通过 Uni-CLI 操作桌面应用。
---

# 浏览器与桌面

Uni-CLI 把浏览器和桌面操作整理成稳定的命令组。先读取状态，选中明确目标，再执行动作。

## 浏览器 session

检查本机设置：

```bash
unicli browser doctor --json
```

启动隐藏的 managed browser：

```bash
unicli browser start
```

在后台使用已有 Chrome session：

```bash
unicli browser --background start
```

打开页面并读取 accessible state：

```bash
unicli browser open https://example.com
unicli browser state -f json
```

状态结果会给交互元素分配 ref。`click`、`type` 和 `query` 等动作使用这个 ref：

```bash
unicli browser click <ref>
unicli browser type <ref> "搜索内容"
```

## 桌面应用

按想完成的事情搜索：

```bash
unicli search "查看桌面应用" --surface desktop
```

第一次使用前读取 compute 健康状态：

```bash
unicli doctor compute -f json
```

先获取 snapshot，再操作返回的 ref：

```bash
unicli compute snapshot --app "Calculator" -f json
unicli compute click <ref> --app "Calculator" -f json
```

可用 provider 取决于操作系统和 accessibility 服务。健康状态会列出已选 provider，并给每个待配置项提供设置动作。

## 选择合适的接口

结构化 API 和 native CLI 适合数据与重复操作；browser semantics 适合登录后的网页；desktop accessibility 可以到达本机 App；visual action 用于只暴露像素的界面。`unicli search` 会显示每条操作使用的 operator。
