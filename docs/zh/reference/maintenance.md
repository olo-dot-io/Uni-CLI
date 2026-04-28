# 维护工具

这些命令用于维护 Uni-CLI 的目录、adapter、schema、统计和公开文档。它们是仓库质量门禁的一部分。

## 常用命令

```bash
npm run format:check
npm run typecheck
npm run lint
npm run build:manifest
npm run lint:adapters
npm run lint:schema-v2
npm run test
npm run test:adapter
npm run conformance
npm run docs:build
```

## Adapter 目录

生成 manifest：

```bash
npm run build:manifest
```

检查 YAML/TypeScript adapter：

```bash
npm run lint:adapters
npm run lint:schema-v2
```

运行 adapter 测试：

```bash
npm run test:adapter
```

## 统计

刷新 README、AGENTS.md 和 stats：

```bash
npm run stats
```

检查统计标记是否同步：

```bash
npm run stats:check
```

## 文档

生成 agent markdown assets 并构建站点：

```bash
npm run docs:build
```

`docs:build` 会同时运行公开文档检查，防止旧文案、错误语言路径或生成资产漂移。

## Skills

仓库内置 skills 放在 `skills/<name>/SKILL.md`。加载顺序是仓库 skills、`$HOME/.unicli/skills`、XDG data 目录。声明 `depends-on` 的 skill 会先加载依赖。

核心 `unicli` skill 依赖 `talk-normal`。写文档、UI 文案、README 或 agent-facing 文本前，先加载这套简洁写作规则。

## Conformance

```bash
npm run conformance
```

它会扫描 adapter 的结构化合同。失败时先看报告，再修 adapter 或 schema。

## 完整门禁

```bash
npm run verify
```

发布或合并前至少跑这条。它比单项检查慢，但能覆盖格式、类型、lint、manifest、测试、统计、conformance 和 exports。
