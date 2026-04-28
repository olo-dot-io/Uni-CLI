# Uni-CLI Skills

Cross-vendor agent skills shipped with the repo. Each `<name>/SKILL.md`
follows the [Agent Skill Protocol v2.0](https://github.com/anthropics/skills)
with `name`, `description`, `triggers` frontmatter, and a progressive
loading layout (L0 index → L1 main → L2 references → L3 external).

These skills are consumable by any agent platform that speaks the
SKILL.md standard: Claude Code, Codex, Hermes, Cline, OpenCode, etc.

## Skills

| Skill                 | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `talk-normal`         | Always-on concise writing rules for docs and UI copy     |
| `unicli`              | Core usage — run any `unicli <site> <command>`           |
| `bgclick-rev`         | IDA-backed research workflow for macOS background clicks |
| `unicli-browser`      | Control Chrome via daemon bridge                         |
| `unicli-claude`       | Claude-specific slash commands (unicli-repair, etc.)     |
| `unicli-explorer`     | Create new adapters by exploring sites/APIs              |
| `unicli-hermes`       | Hermes-platform integration                              |
| `unicli-oneshot`      | One-shot adapter generation from a URL + goal            |
| `unicli-operate`      | Direct browser automation via `operate` subcommands      |
| `unicli-smart-search` | Route search queries to the best platform                |
| `unicli-usage`        | Command reference and usage guide                        |

## Adding a skill

1. Create `skills/<name>/SKILL.md` with v2.0 frontmatter.
2. Keep the protocol section lean (decision trees, not prose).
3. Push large references into `skills/<name>/references/`.
4. Add a row above.
5. `npm run lint:context` scores it against the agent-lint rubric;
   threshold is 60/100.

See `docs/guide/integrations.md`, `contributing/mcp.md`, and the global
skills protocol guide for structure details.
