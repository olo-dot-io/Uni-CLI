# 发布

发布不是固定节奏，而是取决于社区需要和实际开发状态。版本号必须表达真实变化：小修复走 patch，能力扩展走 minor，稳定合同或破坏性变化才走 major。

`1.x` 线代表稳定执行底座合同：命令优先发现和执行、v2 `AgentEnvelope` 输出、可修复 adapter 错误、operation-policy metadata、可选 run recording。

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

## Release label

每个 tagged release 都必须有最终 `Program · Astronaut` label，不能使用
`TBD`、`TODO`、`Unreleased` 或 `Next`。当前公开 program map：

| 版本范围 | Program |
| -------- | ------- |
| `0.1xx`  | Sputnik |
| `0.2xx`  | Vostok  |
| `0.3xx`  | Mercury |
| `0.4xx`  | Gemini  |
| `1.x`    | Apollo  |

`1.0.0` 的候选发布 label 是 `Apollo · Lovell`。

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
