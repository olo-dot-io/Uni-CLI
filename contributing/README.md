# Per-Domain Contributing Guides

The root `CONTRIBUTING.md` is the starting point. These guides go deep on
each contribution surface with concrete file/line references.

| Guide                                            | When to read                                                   |
| ------------------------------------------------ | -------------------------------------------------------------- |
| [`adapter.md`](./adapter.md)                     | Adding or editing a YAML/TS adapter under `src/adapters/`      |
| [`transport.md`](./transport.md)                 | Adding a new `TransportAdapter` (MCP, ACP, CUA, etc.)          |
| [`mcp.md`](./mcp.md)                             | MCP tool registration, OAuth 2.1 PKCE, streaming HTTP surface  |
| [`acp.md`](./acp.md)                             | ACP JSON-RPC frames, session lifecycle, error data             |
| [`cua.md`](./cua.md)                             | CUA backend integration (Anthropic / trycua / opencua / local) |
| [`schema.md`](./schema.md)                       | Schema-v2 fields, migration, `unicli lint` CI gate             |
| [`release.md`](./release.md)                     | Changesets + OIDC npm publish                                  |
| [`branch-protection.md`](./branch-protection.md) | Required CI gates and `gh api` setup script                    |

All files are 50–150 lines and link out to implementation files in
`src/` with line numbers for precise navigation.
