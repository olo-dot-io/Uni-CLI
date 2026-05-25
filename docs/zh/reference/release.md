# 发布

发布不是固定节奏，而是取决于社区需要和实际开发状态。版本号必须表达真实变化：小修复走 patch，能力扩展走 minor，稳定合同或破坏性变化才走 major。

`0.220.x` 线是当前执行底座上的 patch 发布线：命令优先发现和执行、v2 `AgentEnvelope` 输出、可修复 adapter 错误、operation-policy metadata、可选 run recording、论文 PDF 工作流，以及扩展后的 ACG/动画/漫画发现能力。它不是大版本稳定兼容边界。

## 权限边界

发布权由维护者决定。真实 npm 发布不依赖本机 npm 登录态；本机只负责准备、
验证、提交和打 tag。`@zenalexa/unicli` 的真实发布路径是
`.github/workflows/release.yml`：

| 路径         | 入口                                               | 行为                                                  |
| ------------ | -------------------------------------------------- | ----------------------------------------------------- |
| 候选准备     | `main` 上的本地维护者提交                          | 更新版本元数据、changelog、docs、生成资产和测试。     |
| npm 发布     | 推送 `v*` tag 触发 `.github/workflows/release.yml` | checkout 该 tag，验证包面，用 provenance 发布到 npm。 |
| 手动重跑发布 | `release.yml` 的 `workflow_dispatch tag=vX.Y.Z`    | 对已存在 tag 重新执行同一条 GitHub 发布路径。         |

如果本机 `npm whoami` 返回 `E401`，不要在本机修补或绕过 npm auth；只要候选提交
和 tag 能推到 GitHub，就继续走 GitHub Actions 发布。

## 发布前检查

```bash
npm run verify:release-mainline
npm run verify
npm run docs:build
npm run release:check
```

任何版本发布前，都必须先确认 `codex/macos-dynamic-actions` 已经审核、
审查并合并到 `main`。`npm run verify:release-mainline`、`npm run release`
和 `npm run release:check` 会强制检查当前发布从 `main` 发起、提交
`33bafa6087bf81c9b9df5cc0e996e79f6e28f030` 已进入 `HEAD` 历史，并确认
`macos app-actions` / `macos automation-smoke` 已进入 manifest。检查失败时，
先完成审核、审查、合并到 `main`，再重新发布。

`verify` 覆盖格式、类型、lint、manifest、adapter lint、schema lint、构建、单元测试、adapter 测试、统计、conformance 和 exports。

## Changeset

有用户可见变化时，加 changeset：

```bash
npm run changeset
```

文案要具体说明能力变化，不写空泛的“更新文档”或“优化体验”。

## 版本判断

| 类型  | 什么时候用                                               |
| ----- | -------------------------------------------------------- |
| patch | 修 bug、修文档、修已有能力的边界。                       |
| minor | 新 adapter、新命令、新协议能力、向后兼容的新功能。       |
| major | 明确稳定大版本合同，破坏已有公开合同，或者需要用户迁移。 |

## Release label

每个 tagged release 都必须有最终 `Program · Astronaut` label，不能使用
`TBD`、`TODO`、`Unreleased` 或 `Next`。当前公开 program map：

| 版本范围      | Program |
| ------------- | ------- |
| `0.1xx`       | Sputnik |
| `0.200-0.213` | Vostok  |
| `0.216+`      | Apollo  |

`0.221.0` 的发布 label 是 `Apollo · Anders`。

## 发布步骤

```bash
npm run verify:release-mainline
npm run verify
npm run release:check -- --strict-codename
npm publish --dry-run
npm run docs:check-public
```

发布前确认：

- README、AGENTS.md、stats 和 docs 都已同步。
- `docs:build` 通过，公开站点可部署。
- changelog 说清楚用户能得到什么。

真实发布步骤：

```bash
git status --short
git add <release files>
git commit -m "chore(release): vX.Y.Z"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

tag push 会触发 **Actions → Release**。该 workflow 会 checkout tag，重新验证包面，
通过 npm Trusted Publishers 或 `npm-publish` environment 里的 `NPM_TOKEN` fallback
发布，并创建 GitHub Release。

如果 tag 已存在，但 tag push 事件没有运行或被取消，用同一条 GitHub 发布路径重跑：

```bash
gh workflow run release.yml --ref main -f tag=vX.Y.Z
gh run watch --repo olo-dot-io/Uni-CLI
```

workflow 会检查 `tag` 必须等于 `package.json` 里的 `vX.Y.Z`，防止从错误分支头发布。

## 本机 auth 故障 SOP

1. 本机只跑 `npm publish --dry-run`，不要本机真实 `npm publish`。
2. 发布前后用 `npm view @zenalexa/unicli version` 查 registry。
3. `npm whoami` 是 `E401` 时，继续走 GitHub Actions；本机 npm session 不参与发布。
4. `gh auth status` 正常时，推 `main` 和 `vX.Y.Z`，或对已存在 tag dispatch
   `release.yml`。
5. `gh` 不正常但 `git push` 可用时，用 Git 推 tag，再用 GitHub Actions 网页监控或重跑。
6. `gh` 和 `git push` 都不可用时，停在本地验证结果，交接 commit SHA、tag、dry-run
   shasum 和失败 auth 命令；不要用未经验证的本地绕过发布。

## 发布后

发布后检查：

```bash
npm view @zenalexa/unicli version
npx @zenalexa/unicli --version
npx @zenalexa/unicli search "hacker news frontpage"
```

如果站点文档也更新，确认 GitHub Pages workflow 已完成部署。
