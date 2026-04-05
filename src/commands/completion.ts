/**
 * Shell auto-completion generator for bash, zsh, fish.
 */

import { Command } from "commander";
import { listCommands } from "../registry.js";

const BUILTIN_COMMANDS = [
  "list",
  "daemon",
  "operate",
  "record",
  "auth",
  "browser",
  "test",
  "repair",
  "completion",
];

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion")
    .description("Generate shell completion script")
    .argument("<shell>", "shell type: bash, zsh, fish")
    .action((shell: string) => {
      switch (shell) {
        case "bash":
          console.log(bashCompletionScript());
          break;
        case "zsh":
          console.log(zshCompletionScript());
          break;
        case "fish":
          console.log(fishCompletionScript());
          break;
        default:
          console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
          process.exitCode = 1;
      }
    });

  // Hidden flag for internal completion lookups
  program.option("--get-completions", "internal: generate completions");
  program.option("--cursor <n>", "internal: cursor position");
}

/** Get completions for a given cursor position */
export function getCompletions(words: string[], cursor: number): string[] {
  if (cursor <= 1) {
    // Complete site names + builtin commands
    const sites = new Set<string>();
    for (const cmd of listCommands()) {
      sites.add(cmd.site);
    }
    return [...BUILTIN_COMMANDS, ...sites].sort();
  }

  if (cursor === 2) {
    // Complete command names for this site
    const site = words[1];
    const commands = listCommands().filter((c) => c.site === site);
    return commands.map((c) => c.command);
  }

  return [];
}

function bashCompletionScript(): string {
  return `# unicli bash completion
_unicli_completions() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  local words=("\${COMP_WORDS[@]}")
  local completions
  completions=$(unicli --get-completions --cursor "$COMP_CWORD" "\${words[@]}" 2>/dev/null)
  COMPREPLY=( $(compgen -W "$completions" -- "$cur") )
}
complete -F _unicli_completions unicli`;
}

function zshCompletionScript(): string {
  return `#compdef unicli
_unicli() {
  local completions
  completions=("\${(@f)$(unicli --get-completions --cursor $((CURRENT - 1)) "\${words[@]}" 2>/dev/null)}")
  compadd -a completions
}
compdef _unicli unicli`;
}

function fishCompletionScript(): string {
  return `# unicli fish completion
complete -c unicli -f -a '(unicli --get-completions --cursor (count (commandline -cop)) (commandline -cop) 2>/dev/null)'`;
}
