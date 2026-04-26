# 插件开发

插件让 Uni-CLI 可以在核心仓库之外扩展 adapter、命令和能力。插件仍然要遵守同一套命令、输出和错误合同。

## 什么时候写插件

适合写插件的情况：

- 能力属于某个团队或产品，不适合放进核心仓库。
- 需要团队专用 adapter 或私有工具。
- 想把一组相关站点/服务作为一个包维护。

不适合写插件的情况：

- 只是一个普通公开站点 adapter，优先贡献到核心目录。
- 需要绕过认证或安全限制。
- 输出合同和 Uni-CLI 不一致。

## 基本结构

```text
my-unicli-plugin/
  package.json
  adapters/
    example/
      search.yaml
```

Adapter 格式与核心仓库一致：

```yaml
site: example
name: search
type: web-api
strategy: public
pipeline:
  - fetch: { url: "https://api.example.com/search?q=${{ args.query }}" }
  - select: data.results
  - map:
      title: "${{ item.title }}"
      url: "${{ item.url }}"
args:
  query:
    type: str
    required: true
    positional: true
columns: [title, url]
```

## 质量要求

插件 adapter 应该：

- 有清晰的 args schema。
- 输出字段稳定。
- 失败时返回结构化错误。
- 能通过 schema-v2 lint。
- 不把密钥写进 adapter。

## 本地验证

```bash
npm run lint:adapters
npm run lint:schema-v2
unicli search "example search"
unicli example search "query" -f json
```

## 发布建议

插件 README 里至少说明：

- 安装方式。
- 提供哪些站点和命令。
- 是否需要认证。
- 常见失败如何修复。

把命令合同写清楚，比堆长介绍更有用。
