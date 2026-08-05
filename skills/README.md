# Uni-CLI Skills

Cross-vendor agent skills shipped with the repo. Each `<name>/SKILL.md`
follows the [Agent Skill Protocol v2.0](https://github.com/anthropics/skills).
Frontmatter declares `name`, `description`, and `triggers`. Content loads in
four stages from L0 index through L3 external references.

Any agent platform that reads the SKILL.md standard can use them. Current
targets include Claude Code, Codex, Hermes, Cline, and OpenCode.

## Skills

| Skill                 | Purpose                                                                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| `human-writing`       | Primary writing rules for every reply and authored prose artifact                     |
| `unicli`              | Comprehensive guide for discovery, execution, output, auth, errors, and skill routing |
| `bgclick-rev`         | IDA-backed research workflow for macOS background clicks                              |
| `unicli-browser`      | Control broker-owned hidden, existing-Chrome, and remote browser targets              |
| `unicli-claude`       | Claude.ai-specific commands and integration                                           |
| `unicli-claude-code`  | Claude Code CLI integration                                                           |
| `unicli-explorer`     | Create new adapters by exploring sites/APIs                                           |
| `unicli-hermes`       | Hermes-platform integration                                                           |
| `unicli-oneshot`      | One-shot adapter generation from a URL + goal                                         |
| `unicli-operate`      | Direct browser automation via `operate` subcommands                                   |
| `unicli-repair`       | Envelope-driven self-repair workflow for broken adapters                              |
| `unicli-smart-search` | Route search queries to the best platform                                             |
| `unicli-usage`        | Command reference and usage guide                                                     |

## Adding a skill

1. Create `skills/<name>/SKILL.md` with v2.0 frontmatter.
2. Keep the protocol section lean. Prefer decision trees over long prose.
3. Push large references into `skills/<name>/references/`.
4. Add a row above.
5. Run `npm run lint:context`. The agent-lint threshold is 60 out of 100.

`human-writing` is pinned to upstream release 1.1.0 and commit
`4fda173f3fef7fb808f3eba991eeb2528ea4b189`. Keep the Uni-CLI overlay and the
bilingual checker extensions when syncing a newer upstream release.

Codex discovers the same directory through `.codex/skills/human-writing`.
That relative symlink keeps one canonical copy in `skills/human-writing`.

See `docs/guide/integrations.md`, `contributing/mcp.md`, and the global
skills protocol guide for structure details.
