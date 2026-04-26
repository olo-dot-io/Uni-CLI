# 发布

发布不是固定节奏，而是取决于社区需要和实际开发状态。版本号必须表达真实变化：小修复走 patch，能力扩展走 minor，破坏性变化才走 major。

## 发布前检查

```bash
npm run verify
npm run docs:build
npm run release:check
```

`verify` 覆盖格式、类型、lint、manifest、adapter lint、schema lint、构建、单元测试、adapter 测试、统计、conformance 和 exports。

## Changeset

有用户可见变化时，加 changeset：

```bash
npm run changeset
```

文案要具体说明能力变化，不写空泛的“更新文档”或“优化体验”。

## 版本判断

| 类型  | 什么时候用                                         |
| ----- | -------------------------------------------------- |
| patch | 修 bug、修文档、修已有能力的边界。                 |
| minor | 新 adapter、新命令、新协议能力、向后兼容的新功能。 |
| major | 破坏已有公开合同，或者需要用户迁移。               |

## 发布步骤

```bash
npm run verify
npm run changeset:version
npm run build
npm run release
```

发布前确认：

- README、AGENTS.md、stats 和 docs 都已同步。
- `docs:build` 通过，公开站点可部署。
- changelog 说清楚用户能得到什么。

## 发布后

发布后检查：

```bash
npm view @zenalexa/unicli version
npx @zenalexa/unicli --version
npx @zenalexa/unicli search "hacker news frontpage"
```

如果站点文档也更新，确认 GitHub Pages workflow 已完成部署。
