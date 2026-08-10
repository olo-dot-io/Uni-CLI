---
title: 操作目录
description: 按接口类型、站点、命令和认证方式浏览当前生成的操作目录。
---

# 操作目录

这个页面由 `docs/site-index.json` 生成，展示 Uni-CLI 当前能发现和运行的网站、桌面工具、服务和外部 CLI 操作。可以按接口、个人内容或认证要求筛选。展开网站以后可以查看全部命令，每条命令都带有对应的 `unicli describe` 用法。

命令行提供相同的常用入口。

```bash
unicli list --site <site>
unicli list --personalized
unicli search "<意图>" --personalized
```

<SiteCatalog />

## 怎么读这个目录

- **Web API** 优先走 HTTP、Cookie、公开端点或轻量请求。
- **浏览器** 需要真实页面、CDP、截图、点击、输入或网络拦截。
- **桌面** 调用本机应用或本地子进程。
- **桥接** 复用已经安装的外部 CLI。
- **服务** 使用本地或云端服务接口。

目录里的命令名保持英文，因为它们就是实际 CLI 操作名。中文页只翻译解释文字，不改 operation contract。
