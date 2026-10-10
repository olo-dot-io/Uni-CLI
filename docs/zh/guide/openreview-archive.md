---
title: 归档 OpenReview conference
description: 为公开 OpenReview venue 创建可续传的本地归档。
---

# 归档 OpenReview conference

`unicli openreview conference` 收集一个会议的公开投稿、评审讨论、作者回复、录用决定、编辑历史、托管文件和外部研究资源链接。

## 开始归档

传入会议 group ID 或 OpenReview group URL。

```bash
unicli openreview conference "ICML.cc/2026/Conference" \
  --output ./openreview-archives \
  --rpm 20 \
  -f json
```

```bash
unicli openreview conference \
  "https://openreview.net/group?id=ICLR.cc/2025/Conference" \
  --output ./openreview-archives \
  -f json
```

会议 group 配置用于识别不同年份的投稿和决定标题。

## 使用登录 session

OpenReview 要求登录或出现浏览器验证时，先检查本机配置和浏览器状态。

```bash
unicli browser profiles --json
unicli browser doctor --json
unicli --auth-retry openreview conference "ICLR.cc/2025/Conference"
```

归档包含当前账号可读的记录，并将公开字段保存在对应讨论串中。

## 目录结构

```text
openreview-archives/
└── ICML.cc_2026_Conference/
    ├── manifest.json
    ├── group.json
    └── threads/
        └── <forum-id>/
            ├── record.json
            ├── edits/<edit-id>.json
            └── artifacts/<note-id>/<field>-<identity>.*
```

`record.json` 保存原始记录和规范化时间线。下载文件带有附属元数据，记录来源 URL、媒体信息、大小和 SHA-256。

## 继续中断的归档

清单记录进度和已提交的游标。中断后重新运行同一命令。

```bash
unicli openreview conference "ICML.cc/2026/Conference" \
  --output ./openreview-archives \
  --rpm 20
```

已完成的文件通过清单和哈希识别。

## 先收集 metadata

需要先收集讨论、编辑记录、决定和文件引用时，使用 metadata-only 模式。

```bash
unicli openreview conference "NeurIPS.cc/2025/Conference" \
  --metadata-only \
  --output ./openreview-archives
```

`--rpm` 设置当前进程的最大请求速率。多个大型会议归档共用同一 OpenReview 账号时，按顺序运行。
