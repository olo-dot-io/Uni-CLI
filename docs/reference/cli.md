---
title: CLI commands
description: Core Uni-CLI commands for discovery, execution, authentication, browsers, repair, and protocol servers.
---

# CLI commands

The root command is organized around discovery, execution, recovery, and control surfaces.

## Discovery

| Command                                   | Purpose                                    |
| ----------------------------------------- | ------------------------------------------ |
| `unicli search "<intent>"`                | Rank operations by natural-language intent |
| `unicli list`                             | List installed sites and commands          |
| `unicli list --site <site>`               | List commands for one site                 |
| `unicli describe <site> <command>`        | Show arguments and examples                |
| `unicli describe <site> <command> --full` | Show the complete operation contract       |

Use `unicli help <command>` for command-specific flags.

## Execution

```bash
unicli <site> <command> [options]
```

Available global output formats follow.

```text
-f json
-f yaml
-f csv
-f md
-f compact
```

Preview argument resolution and the selected pipeline with `--dry-run`.

## Updates

| Command                                      | Purpose                                  |
| -------------------------------------------- | ---------------------------------------- |
| `unicli upgrade --check -f json`             | Compare installed and available releases |
| `unicli upgrade`                             | Open the interactive Y/N choice          |
| `unicli upgrade --yes`                       | Install without an interactive prompt    |
| `unicli upgrade --no`                        | Remind again after 24 hours              |
| `unicli upgrade --skip-version`              | Hide the currently offered release       |
| `unicli upgrade --auto-update`               | Enable automatic updates on this machine |
| `unicli upgrade --no-auto-update`            | Require explicit approval                |
| `unicli upgrade --package-manager <manager>` | Override npm, pnpm, or Bun detection     |

See [Keep Uni-CLI current](../guide/upgrading) for Agent metadata and installation boundaries.

## Authentication

| Command                                      | Purpose                                 |
| -------------------------------------------- | --------------------------------------- |
| `unicli auth setup <site>`                   | Show the credentials required by a site |
| `unicli auth import <site> --browser chrome` | Import a browser login for one site     |
| `unicli auth check <site>`                   | Validate saved site credentials         |
| `unicli auth list`                           | List configured sites                   |
| `unicli doctor cookies`                      | Diagnose browser cookie access          |

## Browser

| Command                             | Purpose                                            |
| ----------------------------------- | -------------------------------------------------- |
| `unicli browser doctor --json`      | Report browser, profile, broker, and policy status |
| `unicli browser profiles --json`    | List local Chromium profiles                       |
| `unicli browser start`              | Start the managed provider                         |
| `unicli browser --background start` | Use existing Chrome with background visibility     |
| `unicli browser --focus start`      | Use existing Chrome in the foreground              |
| `unicli browser state -f json`      | Read the accessible page state                     |
| `unicli browser screenshot <path>`  | Capture the current page                           |

Run `unicli help browser` for the complete action list.

## Desktop

| Command                                         | Purpose                      |
| ----------------------------------------------- | ---------------------------- |
| `unicli doctor compute -f json`                 | Check desktop providers      |
| `unicli compute snapshot --app <name>`          | Read an application snapshot |
| `unicli compute click <ref> --app <name>`       | Activate an element          |
| `unicli compute type <ref> <text> --app <name>` | Enter text                   |

## Repair and authoring

| Command                                    | Purpose                              |
| ------------------------------------------ | ------------------------------------ |
| `unicli repair <site> <command> --dry-run` | Preview verification                 |
| `unicli repair <site> <command>`           | Verify the updated adapter           |
| `unicli init <site> <command>`             | Create a YAML adapter                |
| `unicli dev <path>`                        | Reload an adapter during development |
| `unicli test <site>`                       | Run adapter checks                   |

## Run evidence and evolution

| Command                                                            | Purpose                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| `unicli runs list`                                                 | List local recorded runs                               |
| `unicli runs distill <run_ids...>`                                 | Create a redacted evidence packet                      |
| `unicli evolve adapter <site> <command>`                           | Create an isolated YAML adapter draft                  |
| `unicli evolve adapter <site> <command> --candidate ... --promote` | Verify and conditionally promote a supplied candidate  |
| `unicli evolve verify <session_id> [--promote]`                    | Append an attempt or promote an unchanged verified one |
| `unicli evolve inspect [session_id]`                               | List sessions or inspect one session                   |
| `unicli evolve rollback <session_id>`                              | Restore the exact pre-promotion user overlay           |

Proposal runs provide evidence for the Agent and cannot also serve as validation or held-out runs. A changed candidate must declare a falsifiable hypothesis and expected fixes. It must improve validation without regressions, preserve held-out behavior, and retain its baseline authorization scope. Mutation evaluation remains disabled unless the caller passes `--allow-mutation-eval`.

## Plugins

| Command                        | Purpose                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| `unicli plugin inspect <path>` | Validate an Agent Plugins 1.0 package and show its projection |
| `unicli plugin create <name>`  | Scaffold portable skills plus a Uni-CLI runtime extension     |
| `unicli plugin list`           | List installed portable and native plugins                    |

## Protocol servers

| Command                     | Purpose                          |
| --------------------------- | -------------------------------- |
| `unicli mcp serve`          | Start the MCP server             |
| `unicli mcp health -f json` | Show MCP profile and tool counts |
| `unicli acp serve`          | Start the ACP server             |
