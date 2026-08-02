# 归档 OpenReview 会议

`unicli openreview conference` 为一个 OpenReview venue 建立可续传的研究归档。
每篇公开投稿会与审稿线程、rebuttal、决定、修改历史、站内文件和外部 artifact
链接保存在一起。

## 从会议 group 开始

传入规范 group id 或 OpenReview group URL：

```bash
unicli --auth-retry openreview conference \
  "ICML.cc/2026/Conference" \
  --output ~/openreview-archives \
  --rpm 20 \
  -f json
```

```bash
unicli --auth-retry openreview conference \
  "https://openreview.net/group?id=ICLR.cc/2025/Conference" \
  --output ~/openreview-archives \
  -f json
```

适配器读取 group 的 `submission_id`，优先使用 OpenReview API v2，并为旧会议
回退到 API v1。不同年份采用不同 invitation 名称或 decision label 时，group
配置仍是查询依据。

## 登录态

OpenReview 要求 access token 或浏览器 challenge 时，使用已经登录的浏览器会话：

```bash
unicli browser profiles --json
unicli browser doctor --json
unicli --auth-retry openreview conference "ICLR.cc/2024/Conference"
```

OpenReview 客户端可在一次 invocation 内刷新一次过期的 access token。Access 和
clearance credential 只会发往 OpenReview host；refresh credential 只会发往
OpenReview token endpoint。归档只接收 `readers` 包含 `everyone` 的记录和字段。

## 归档结构

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

`record.json` 保留公开 submission、reply 原始对象和按时间排序的规范 timeline。
Timeline entry 包含稳定的 note id、parent id、从 invitation 推导的生命周期类型、
来源 URL、全部内容区段，以及 weakness、concern、question、limitation、issue
字段组成的 `concerns` 视图。

OpenReview 托管的 PDF、补充材料、appendix、source bundle、代码包、artifact 和
rebuttal attachment 会串行下载。每个二进制文件都有 JSON sidecar，记录来源 URL、
大小、媒体 header 和 SHA-256。外部 repository、project、dataset URL 作为结构化
链接保留，后续可按对应 host 的认证和限流合同独立归档。

## 请求节奏与恢复

默认速率为每分钟 20 个请求，每个进程同时只有一个 OpenReview 请求。客户端遵循
`Retry-After` 和 rate-limit reset header；临时 API 故障使用有上限的指数退避和
jitter 重试。

多个会议按顺序运行，使总请求速率保持可预测：

```bash
for year in 2026 2025 2024; do
  unicli --auth-retry openreview conference \
    "ICLR.cc/${year}/Conference" \
    --output ~/openreview-archives \
    --rpm 20 \
    -f json
done
```

Submission、revision 和最后一次 edit-head catch-up 全部结束前，manifest 一直是
`in_progress`。中断后重新执行同一条命令；已提交的 cursor 和 artifact hash 会
阻止已完成内容被重复获取。

只需要 note、revision 和 artifact reference 时，使用 metadata-only 模式：

```bash
unicli --auth-retry openreview conference \
  "NeurIPS.cc/2025/Conference" \
  --metadata-only \
  --output ~/openreview-archives \
  -f json
```

## 归档前检查会议标签页

`openreview venue` 接受浏览器显示的 URL，包括 venue tab：

```bash
unicli openreview venue \
  "https://openreview.net/group?id=ICML.cc/2026/Conference#tab-accept-spotlight" \
  --limit 25 \
  -f json
```

命令通过 venue 当前的 decision-heading map 解析 tab，显示标签的大小写不会成为
API 查询假设。
