---
title: 浏览器与桌面
description: 选择浏览器 session，读取页面状态，并通过 Uni-CLI 操作桌面应用。
---

# 浏览器与桌面

Uni-CLI 把浏览器和桌面操作整理成稳定的命令组。先读取状态，选中明确目标，再执行动作。

## 浏览器 session

检查本机设置。

```bash
unicli browser doctor --json
```

启动隐藏的 managed browser。

```bash
unicli browser start
```

在后台使用已有 Chrome session。

```bash
unicli browser --background start
```

打开页面并读取 accessible state。

```bash
unicli browser open https://example.com
unicli browser state -f json
```

状态结果会给交互元素分配 ref。`click`、`type` 和 `query` 等动作使用这个 ref。

```bash
unicli browser click <ref>
unicli browser type <ref> "搜索内容"
```

## 桌面应用

按想完成的事情搜索。

```bash
unicli search "查看桌面应用" --surface desktop
```

第一次使用前读取 compute 健康状态。

```bash
unicli doctor compute --json
```

先获取 snapshot，再操作返回的 ref。

```bash
unicli compute snapshot --app "Calculator" -f json
unicli compute click <ref> --app "Calculator" -f json
```

可用 provider 取决于操作系统和 accessibility 服务。健康状态会列出已选 provider，并给每个待配置项提供设置动作。

## 原生坐标驱动

Cua Driver 通过显式 `--via driver` 路径执行桌面像素操作。运行 provider 检查后，缺失的驱动会通过官方安装器安装，macOS 辅助功能和屏幕录制权限会显示各自状态。

```bash
unicli doctor compute --providers --install --json
unicli compute screenshot --via driver -f json
```

先查看截图，按图中的像素坐标选定目标，再将 `.data.observation.ref` 传给 `compute point-click <x> <y> --observation <ref> --via driver`。每个 observation 在 30 秒后过期，并且只能用于一次坐标操作。可见目标变化或驱动重启后，重新截图。

Uni-CLI 传递 capture 身份、驱动 session 和截图坐标。Cua Driver 负责 Retina 缩放与限尺寸截图的坐标转换。2026-10-10 的 macOS 实机检查已确认驱动 0.34.0、权限和截图。行为场景分别验证 capture 绑定的坐标、Retina 缩放和 observation 单次使用。权限缺失和 provider 故障会返回结构化恢复信息。

## 选择合适的接口

结构化 API 和 native CLI 适合数据与重复操作；browser semantics 适合登录后的网页；desktop accessibility 可以到达本机 App；visual action 用于只暴露像素的界面。`unicli search` 会显示每条操作使用的 operator。
