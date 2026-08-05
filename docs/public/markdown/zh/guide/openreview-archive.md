<!-- 由 docs/zh/guide/openreview-archive.md 生成。不要直接编辑此副本。 -->

# 归档 OpenReview

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/openreview-archive
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/openreview-archive.md
- 栏目: 使用 Uni-CLI
- 上级: 使用 Uni-CLI (/zh/guide/)

`unicli openreview conference` 会收集一个 venue 的公开投稿、评审讨论、rebuttal、决定、编辑历史、托管文件和外部 artifact link。

## 开始归档

传入 venue group ID 或 OpenReview group URL：

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

Venue group 配置用于识别不同年份的 submission 和 decision heading。

## 使用登录 session

OpenReview 要求登录或出现 browser challenge 时，先检查本机 profile 和浏览器状态：

```bash
unicli browser profiles --json
unicli browser doctor --json
unicli --auth-retry openreview conference "ICLR.cc/2025/Conference"
```

归档会包含当前账号可读的记录，并把公开字段保存在对应 thread 中。

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

`record.json` 保存源 note 和规范化的时间线。下载 artifact 会带 sidecar metadata，记录 source URL、media 信息、大小与 SHA-256。

## 继续中断的归档

Manifest 记录进度与已提交 cursor。中断后重新运行同一命令：

```bash
unicli openreview conference "ICML.cc/2026/Conference" \
  --output ./openreview-archives \
  --rpm 20
```

已完成 artifact 会根据 manifest 和 hash 被识别。

## 先收集 metadata

先收集 thread、edit、decision 和 artifact reference 时，使用 metadata-only：

```bash
unicli openreview conference "NeurIPS.cc/2025/Conference" \
  --metadata-only \
  --output ./openreview-archives
```

`--rpm` 设置当前进程的最大请求速率。多个大 venue 使用同一 OpenReview 账号时，按顺序运行。
