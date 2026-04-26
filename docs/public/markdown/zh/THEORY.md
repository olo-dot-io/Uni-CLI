<!-- 由 docs/zh/THEORY.md 生成。不要直接编辑此副本。 -->

# 理论

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/THEORY
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/THEORY.md
- 栏目: 解释
- 上级: 解释 (/zh/ARCHITECTURE)

Uni-CLI 的基本判断很简单：智能体要操作真实世界的软件，不应该先被迫学习每个网站、每个桌面应用、每个协议的细节。它需要一个小而稳定的命令层。

## 命令比工具描述更适合执行

工具描述告诉智能体“可能能做什么”。命令告诉智能体“现在怎么做”。

一条好命令应该有：

- 可搜索的意图描述。
- 明确的 args schema。
- 可预测的输出字段。
- 结构化错误。
- 可修复的 adapter 路径。

## 发现和执行分开

智能体先用 `unicli search` 发现候选命令，再用具体命令执行。

这样有两个好处：

- 搜索可以很宽，执行可以很窄。
- 执行时不需要把整个目录塞进上下文。

## 错误也是接口

如果失败只是一段 stderr，智能体只能猜。Uni-CLI 把错误也做成接口：

```yaml
error:
  code: selector_miss
  adapter_path: src/adapters/example/search.yaml
  step: 2
  retryable: false
  suggestion: "Update the selector."
```

这让修复成为流程的一部分，而不是人工事后排查。

## YAML 是协作格式

YAML adapter 不只是配置，也是智能体可以读写的协作格式。短、明确、可 diff，适合快速修复。

TypeScript 仍然需要，但它应该处理 YAML 做不到的事情，而不是成为默认选择。

## 协议是兼容层

Uni-CLI 提供 MCP、ACP 等协议入口，但核心合同仍然是命令：

```bash
unicli <site> <command> [args]
```

原因是 shell 已经是 coding agent 的自然环境。协议可以接入更多客户端，但不应该替代最短的执行路径。
