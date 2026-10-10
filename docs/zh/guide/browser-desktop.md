---
title: 浏览器与桌面
description: 选择浏览器 session，读取页面状态，并通过 Uni-CLI 操作桌面应用。
---

# 浏览器与桌面

Uni-CLI 把浏览器和桌面操作整理成稳定的命令组。先读取状态，选中明确目标，再执行动作。

## 浏览器会话

检查本机设置。

```bash
unicli browser doctor --json
```

启动隐藏的托管浏览器。

```bash
unicli browser start
```

在后台使用已有 Chrome 会话。

```bash
unicli browser --background start
```

模式选择只作用于当前 CLI 调用。后续命令继续使用已有 Chrome 时，每次都加上 `--background`。下面省略模式参数的命令使用默认隐藏托管浏览器。

打开页面并读取无障碍状态。

```bash
unicli browser open https://example.com
unicli browser state -f json
```

状态结果会为交互元素分配引用 ref。执行 `click`、`type` 和 `query` 等动作时，使用本次状态读取返回的 ref。

```bash
unicli browser click <ref>
unicli browser type <ref> "搜索内容"
```

## 桌面应用

按想完成的事情搜索。

```bash
unicli search "查看桌面应用" --surface desktop
```

第一次操作桌面前，检查可用驱动和权限。

```bash
unicli doctor compute --json
```

先获取界面快照，再操作返回的 ref。

```bash
unicli compute snapshot --app "Calculator" -f json
unicli compute click <ref> --app "Calculator" -f json
```

可用驱动取决于操作系统和无障碍服务。健康检查会列出选中的驱动，并给每个待配置项提供设置动作。

## 原生坐标驱动

通过 `--via driver` 显式选择 Cua Driver，执行桌面像素操作。以下命令会检查驱动，通过官方安装器安装缺失组件，并报告 macOS 辅助功能和屏幕录制权限。

```bash
unicli doctor compute --providers --install --json
unicli compute screenshot --via driver -f json
```

先查看截图，按图中的像素坐标选定目标，再将 `.data.observation.ref` 传给 `compute point-click <x> <y> --observation <ref> --via driver`。每个 observation 在 30 秒后过期，并且只能用于一次坐标操作。可见目标变化或驱动重启后，重新截图。

Uni-CLI 向 Cua Driver 传递截图标识、驱动会话和截图坐标。驱动负责 Retina 缩放及限尺寸截图的坐标转换。直接使用返回图片中的像素坐标，无需再次按屏幕缩放比例换算。权限缺失和驱动故障会返回结构化恢复信息，按其中的下一步动作完成配置。

## 选择合适的接口

获取数据和重复操作优先使用结构化 API 或原生 CLI。登录后的网页可使用浏览器元素操作，本机应用可使用桌面无障碍接口。只有像素可供定位的界面使用视觉操作。`unicli search` 会显示每条操作的执行接口。
