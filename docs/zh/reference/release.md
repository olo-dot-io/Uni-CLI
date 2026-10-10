# 发布

维护者根据社区需要、变更范围和验证结果决定发布时机。版本号表达实际变化，小修复使用 patch，能力扩展使用 minor，稳定大版本契约或破坏性变化使用 major。

`0.400.0` 是浏览器运行时重构对应的 minor 版本。它统一管理浏览器所有权，并新增通用 Agent 浏览器控制接口。这个版本号高于此前发布的 `0.227.1`，保持 SemVer 升级顺序。

## 权限边界

发布权由维护者决定。真实 npm 发布不依赖本机 npm 登录态；本机只负责准备、验证、提交和打 tag。`@zenalexa/unicli` 的真实发布路径是 `.github/workflows/release.yml`。

| 路径         | 入口                                               | 行为                                                  |
| ------------ | -------------------------------------------------- | ----------------------------------------------------- |
| 候选准备     | `main` 上的本地维护者提交                          | 更新版本元数据、changelog、docs、生成资产和测试。     |
| npm 发布     | 推送 `v*` tag 触发 `.github/workflows/release.yml` | checkout 该 tag，验证包面，用 provenance 发布到 npm。 |
| 手动重跑发布 | `release.yml` 的 `workflow_dispatch tag=vX.Y.Z`    | 对已存在 tag 重新执行同一条 GitHub 发布路径。         |

本机 `npm whoami` 返回 `E401` 时，不在本机修补或绕过 npm auth。候选提交和 tag 推送到 GitHub 后，继续通过 GitHub Actions 发布。

## 发布前检查

```bash
npm run verify:release-mainline
npm run verify
npm run docs:build
npm run release:check
```

版本发布前必须确认 `codex/macos-dynamic-actions` 已审核、审查并合并到 `main`。`npm run verify:release-mainline`、`npm run release` 和 `npm run release:check` 强制检查当前发布从 `main` 发起、提交 `33bafa6087bf81c9b9df5cc0e996e79f6e28f030` 已进入 `HEAD` 历史，并确认 `macos app-actions` / `macos automation-smoke` 已进入 manifest。检查失败时，先完成审核、审查并合并到 `main`，再重新发布。

`verify` 覆盖格式、类型、lint、manifest、adapter lint、schema lint、构建、单元测试、adapter 测试、统计、conformance 和 exports。

## 历史发布审计

公开 Git 与标签历史从 2026 年的 `0.200.x` 线开始。以下保留 `0.400.2` 的历史发布记录，版本名为 `Apollo · Duke`，对应 npm 与 GitHub 的同一 annotated tag。

交付事实。

- 发布后，npm registry 上 `@zenalexa/unicli@latest` 为 `0.400.2`；
- annotated tag `v0.400.2` 指向 main commit `785c3ef65c915a88ecd4d63f63d22f0c5f89f09b`；
- tag workflow `29658936515` 重建两个 Windows sidecar，重跑完整 release gate，并通过 npm Trusted Publishers 发布，未使用 fallback token；
- npm 已记录 tagged workflow 的 SLSA v1 provenance；发布包包含 4,110 个文件，SHA-1 为 `8f96798991e883acf98d350fc54a1ba2da8c00fc`，integrity 为 `sha512-u0gM4CRwm18eaprAYdzZTX7qpVrQJJdfG5oRCG3Lo0wv8H+2w8g6LBPgtb3YRWvUZqAqpclyZBlvDM/oHqixdQ==`；
- GitHub Release 中的 x64 与 arm64 Windows process-owner 可执行文件，与 npm tarball 内对应文件逐字节一致；
- 两个本机 global prefix 的全新 registry 安装均可执行并报告 `0.400.2`；
- 完整仓库门禁通过 3,293 个 unit（4 个跳过）、94 个 integration（16 个平台跳过）、6,523 个 adapter、5 个 performance（1 个跳过）和 42 个 100% 定向 coverage 行为；production audit 为零漏洞。

| Release line | 历史角色                                                                                               | 审计结论                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `0.200.0`    | 第一个 Vostok public adapter platform，带 build manifest 和 self-repair architecture。                 | 发布必须暴露机器可读 surface，不能只写定位。                                           |
| `0.208.0`    | Skills export、MCP gateway、eval catalog、usage ledger、operate/observe，以及 4-reviewer hardening。   | Review finding 要明确，安全和 release wiring 问题必须在 tag 前修掉。                   |
| `0.213.0`    | Engine rigor GA。executor/runtime/steps 拆分、schema-v2 adapter、v2 `AgentEnvelope`。                  | 稳定行为合同比营销叙事更重要。                                                         |
| `0.217.0`    | Execution-substrate 定位，加 operation policy、run recording、browser evidence、agent backend matrix。 | 随着真实控制面扩张，旧定位会变小。                                                     |
| `0.218.0`    | 跨平台 browser cookie import 和 auth diagnostics。                                                     | Auth 和平台边界必须说清楚，不支持的路径要诚实失败。                                    |
| `0.221.0`    | Patent / scholarly verticals 带 typed records 和 source routing。                                      | 垂直覆盖必须伴随 record、provenance 和测试。                                           |
| `0.222.0`    | Local computer-use 和 compute capture 进入发布面。                                                     | Desktop/computer control 是核心 substrate，不是 sidecar demo。                         |
| `0.224.0`    | Callable architecture audit/tree 和 registry-backed search cache。                                     | Architecture audit 不能遗漏 core control command，也不能把产品退回 adapter lifecycle。 |
| `0.225.0`    | 通用 computer-control 平台 framing。intent、policy、action substrate、evidence、delivery、repair。     | 产品主张需要 live health gate，不能只看 catalog count。                                |
| `0.227.1`    | 可移植 release truth、credential privacy、精确 repair 和跨平台 publication gate。                      | 宿主污染证据失败时，release candidate 必须停在发布之前。                               |
| `0.400.0`    | 共享 browser/computer runtime，加上通用 Agent browser control、search 和 foreground presence。         | Runtime 复用必须伴随显式 target ownership、有界 perception 和真实的 no-focus 合同。    |
| `0.400.1`    | 领域无关的联邦检索内核，加面向角色的 AI Infra 情报 overlay。                                           | 扩大覆盖时，source execution、evidence contract 与 domain attribution 必须保持解耦。   |
| `0.400.2`    | Open Agent-Computer Interface 定位，加精确 retrieval、diagnostics 与 target-bound compute execution。  | 广泛控制必须保持 routing、evidence、operation identity 与 target ownership 精确。      |

`0.400.0` 的 minor 变更覆盖运行时所有权和面向 Agent 的浏览器协议，包名与命令响应契约保持稳定。`0.400.1` 以 patch 版本扩展兼容接口，并补齐发布包一致性、跨平台 broker 启动和发布状态验证。`0.400.2` 继续保持包与响应契约，改进检索相关性、跨传输诊断、MCP 路由和桌面目标绑定。

## Changeset

存在用户可见变更时添加 changeset。

```bash
npm run changeset
```

文案说明具体能力、用户影响和必要操作。

## 版本判断

| 类型  | 什么时候用                                                       |
| ----- | ---------------------------------------------------------------- |
| patch | 修 bug、修文档、修已有能力的边界。                               |
| minor | 产品模型重塑、新 adapter、新命令、新协议能力、向后兼容的新功能。 |
| major | 明确稳定大版本合同，破坏已有公开合同，或者需要用户迁移。         |

## Release label

每个 tagged release 必须带有最终 `Program · Astronaut` label，不使用 `TBD`、`TODO`、`Unreleased` 或 `Next`。当前公开 program map。

| 版本范围      | Program |
| ------------- | ------- |
| `0.1xx`       | Sputnik |
| `0.200-0.213` | Vostok  |
| `0.216+`      | Apollo  |

`0.400.2` 的已发布 label 是 `Apollo · Duke`。

## 发布步骤

```bash
npm run verify:release-mainline
npm run verify
npm run release:check -- --strict-codename
npm publish --dry-run
npm run docs:check-public
```

发布前确认。

- README、AGENTS.md、stats 与 docs 均已同步。
- `docs:build` 通过，公开站点可部署。
- changelog 明确说明用户获得的内容。
- 产品模型重塑发布时更新本页历史发布审计。

候选交付使用默认的 `local` 状态，生成文档不会将尚未发生的 npm 或 GitHub Release 记录为既成事实。两个公开端点均验证通过后，将元数据切换到 `published`。

```bash
npx tsx scripts/release.ts --codename "Apollo · Duke" --status published
```

`0.400.2` 的切换发生在 registry、provenance、Release asset、完整 release gate、production-only 安装和精确 installed-version probe 全部通过之后。

真实发布步骤。

```bash
git status --short
git add <release files>
git commit -m "chore(release): vX.Y.Z"
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z — Program · Astronaut"
git push origin vX.Y.Z
```

tag push 触发 **Actions → Release**。该 workflow 检出 tag 并重新验证包内容，通过 npm Trusted Publishers 或 `npm-publish` environment 中的 `NPM_TOKEN` fallback 发布，并创建 GitHub Release。

tag 已存在且 tag push 事件未运行或被取消时，使用同一 GitHub 发布路径重新运行。

```bash
gh workflow run release.yml --ref main -f tag=vX.Y.Z
gh run watch --repo olo-dot-io/Uni-CLI
```

workflow 检查 `tag` 必须与 `package.json` 中的 `vX.Y.Z` 一致，防止从错误分支头发布。

## 本机 auth 故障 SOP

1. 本机只执行 `npm publish --dry-run`，不在本机执行实际 `npm publish`。
2. 发布前后使用 `npm view @zenalexa/unicli version` 查询 registry。
3. `npm whoami` 为 `E401` 时，继续通过 GitHub Actions 发布，本机 npm session 不参与发布。
4. `gh auth status` 正常时，推送 `main` 与 `vX.Y.Z`，或对已有 tag 调度 `release.yml`。
5. `gh` 异常且 `git push` 可用时，使用 Git 推送 tag，再通过 GitHub Actions 网页监控或重新运行。
6. `gh` 与 `git push` 均不可用时，保留本地验证结果，交接 commit SHA、tag、dry-run shasum 与失败的 auth 命令，不使用未经验证的本地绕过方案发布。

## 发布后

发布后检查。

```bash
npm view @zenalexa/unicli version
npx @zenalexa/unicli --version
npx @zenalexa/unicli search "hacker news frontpage"
```

站点文档同步更新时，确认 GitHub Pages workflow 已完成部署。
