/**
 * @owner   src/discovery/core-catalog.ts
 * @does    Catalog core Uni-CLI commands that are implemented by Commander modules instead of adapter manifests.
 * @needs   none
 * @feeds   src/discovery/search.ts, src/fast-path/handlers/discovery.ts, src/mcp/handler.ts, src/cli.ts
 * @breaks  Missing core rows make built-in capabilities executable but undiscoverable through search/list/MCP.
 */

import type { TargetSurface } from "../types.js";
import {
  getComputeCommandContract,
  type ComputeCommandArg,
} from "../compute/contracts.js";

export interface CoreDiscoveryArg {
  name: string;
  type?: "str" | "int" | "float" | "bool";
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  description?: string;
}

export interface CoreDiscoveryCommand {
  site: string;
  command: string;
  description: string;
  category: string;
  type: string;
  target_surface?: TargetSurface;
  source_path?: string;
  args?: readonly CoreDiscoveryArg[];
  channels?: Record<string, string>;
}

const CORE_COMMAND_SOURCE_PATHS: Record<string, string> = {
  agents: "src/commands/agents.ts",
  architecture: "src/commands/architecture.ts",
  browser: "src/commands/browser/index.ts",
  compute: "src/commands/compute.ts",
  delivery: "src/commands/delivery.ts",
  mcp: "src/commands/mcp.ts",
  operate: "src/commands/operate.ts",
  runs: "src/commands/runs.ts",
};

const CORE_DISCOVERY_COMMANDS: readonly CoreDiscoveryCommand[] = [
  {
    site: "browser",
    command: "evidence",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Capture browser operator evidence for web automation, website control, agent workflows, MCP/CLI debugging, DOM snapshots, screenshots, network summaries, render-aware observation, session leases, and audit trails.",
  },
  {
    site: "browser",
    command: "extract",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Extract rendered website text through the browser operator with render-aware waiting, session lease metadata, DOM evidence, and agent-friendly structured output.",
  },
  {
    site: "browser",
    command: "state",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Read the current browser page state, accessibility tree, refs, URL, and DOM snapshot for website control and agent browser automation.",
  },
  {
    site: "browser",
    command: "click",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Click a browser page ref with stale-ref checks, session lease ownership, action evidence, watchdog movement checks, and recorded run traces.",
  },
  {
    site: "browser",
    command: "bind",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Bind the current visible browser tab into a named workspace with domain and path guards for profile reuse and multi-command automation.",
  },
  {
    site: "operate",
    command: "state",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Inspect the current browser automation workspace for agent operation, website control, page refs, and accessibility tree state.",
  },
  {
    site: "operate",
    command: "click",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Operate a browser page by clicking refs with recorded evidence and session lease metadata.",
  },
  {
    site: "mcp",
    command: "serve",
    category: "dev",
    type: "service",
    description:
      "Serve Uni-CLI through MCP for agents, exposing command search, command run, browser/web capabilities, structured envelopes, and protocol integration.",
  },
  {
    site: "agents",
    command: "recommend",
    category: "dev",
    type: "service",
    description:
      "Recommend the right agent backend or CLI for a task, including Codex, Claude Code, OpenCode, MCP, ACP, browser, desktop, and tool workflows.",
  },
  {
    site: "runs",
    command: "list",
    category: "dev",
    type: "service",
    description:
      "List recorded Uni-CLI run traces, browser session leases, evidence events, watchdog outcomes, command status, and replay/index metadata.",
  },
  {
    site: "runs",
    command: "show",
    category: "dev",
    type: "service",
    description:
      "Show recorded run trace events for debugging, replay preparation, browser lease evidence, render stability, and agent audit review.",
  },
  {
    site: "runs",
    command: "probe",
    category: "dev",
    type: "service",
    description:
      "Probe a recorded run trace for exact replay readiness, private args availability, command metadata, and evidence-backed reproducibility.",
  },
  {
    site: "runs",
    command: "replay",
    category: "dev",
    type: "service",
    description:
      "Replay a recorded command through the native execution kernel, write a fresh replay trace, and gate behavior, context, or overall scores.",
  },
  {
    site: "runs",
    command: "compare",
    category: "dev",
    type: "service",
    description:
      "Compare two recorded run traces for behavior drift, context drift, score gates, result envelope differences, repair verification, and reproducible agent audit checks.",
  },
  {
    site: "delivery",
    command: "assess",
    category: "dev",
    type: "service",
    description:
      "Assess an objective delivery spec from recorded run evidence, classify failure state, and choose the next action for agent self-repair, retry, auth, permission, or stop.",
  },
  {
    site: "delivery",
    command: "run",
    category: "dev",
    type: "service",
    description:
      "Execute the next delivery experiment from an objective spec through the shared command kernel, record the new run trace, and return the updated trajectory.",
  },
  {
    site: "delivery",
    command: "trajectory",
    category: "dev",
    type: "service",
    description:
      "Build a reviewable objective trajectory from run evidence with failed gates, diagnosis, hypothesis, verification status, and the next executable experiment for closed-loop agents.",
  },
  {
    site: "delivery",
    command: "repair-candidate",
    category: "dev",
    type: "service",
    description:
      "Compile a delivery trajectory into one bounded adapter repair candidate with adapter path, diagnosis, verify command, and repair safety constraints.",
  },
  {
    site: "architecture",
    command: "tree",
    category: "dev",
    type: "service",
    description:
      "Emit Uni-CLI's callable computer-control architecture tree for agents, including operation contracts, control kernel, action substrates, evidence delivery, runtime exposure, internal authoring cycle, and verification roots.",
  },
  {
    site: "architecture",
    command: "audit",
    category: "dev",
    type: "service",
    description:
      "Audit Uni-CLI computer-control readiness before restructuring, including command counts, local computer-use coverage, control stages, missing source paths, substrate identity boundaries, and full rewrite readiness.",
  },
  {
    site: "compute",
    command: "apps",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("apps"),
  },
  {
    site: "compute",
    command: "windows",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("windows"),
  },
  {
    site: "compute",
    command: "snapshot",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("snapshot"),
  },
  {
    site: "compute",
    command: "capture",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("capture"),
  },
  {
    site: "compute",
    command: "find",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("find"),
  },
  {
    site: "compute",
    command: "click",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("click"),
  },
  {
    site: "compute",
    command: "type",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("type"),
  },
  {
    site: "compute",
    command: "press",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("press"),
  },
  {
    site: "compute",
    command: "scroll",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("scroll"),
  },
  {
    site: "compute",
    command: "launch",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("launch"),
  },
  {
    site: "compute",
    command: "screenshot",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("screenshot"),
  },
  {
    site: "compute",
    command: "attach",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("attach"),
  },
  {
    site: "compute",
    command: "eval",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("eval"),
  },
  {
    site: "compute",
    command: "wait",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("wait"),
  },
  {
    site: "compute",
    command: "observe",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("observe"),
  },
  {
    site: "compute",
    command: "assert",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("assert"),
  },
];

export function listCoreDiscoveryCommands(): CoreDiscoveryCommand[] {
  return CORE_DISCOVERY_COMMANDS.map(withCoreSourcePath).sort(
    (a, b) =>
      a.site.localeCompare(b.site) || a.command.localeCompare(b.command),
  );
}

export function getCoreDiscoveryCommand(
  site: string,
  command: string,
): CoreDiscoveryCommand | undefined {
  const coreCommand = CORE_DISCOVERY_COMMANDS.find(
    (candidate) => candidate.site === site && candidate.command === command,
  );
  return coreCommand ? withCoreSourcePath(coreCommand) : undefined;
}

export function listCoreDiscoverySites(): Array<{
  site: string;
  category: string;
  type: string;
  commands: CoreDiscoveryCommand[];
}> {
  const sites = new Map<
    string,
    { category: string; type: string; commands: CoreDiscoveryCommand[] }
  >();
  for (const command of CORE_DISCOVERY_COMMANDS.map(withCoreSourcePath)) {
    const entry = sites.get(command.site) ?? {
      category: command.category,
      type: command.type,
      commands: [],
    };
    entry.commands.push(command);
    sites.set(command.site, entry);
  }
  return Array.from(sites.entries())
    .map(([site, info]) => ({
      site,
      category: info.category,
      type: info.type,
      commands: [...info.commands].sort((a, b) =>
        a.command.localeCompare(b.command),
      ),
    }))
    .sort((a, b) => a.site.localeCompare(b.site));
}

export function coreDiscoveryCategory(site: string): string | undefined {
  return CORE_DISCOVERY_COMMANDS.find((command) => command.site === site)
    ?.category;
}

function withCoreSourcePath(
  command: CoreDiscoveryCommand,
): CoreDiscoveryCommand {
  return {
    ...command,
    source_path: command.source_path ?? CORE_COMMAND_SOURCE_PATHS[command.site],
  };
}

function computeCommandFields(
  command: string,
): Pick<CoreDiscoveryCommand, "args" | "channels" | "description"> {
  const contract = getComputeCommandContract(command);
  if (!contract) {
    throw new Error(`missing compute command contract for ${command}`);
  }
  return {
    description: contract.description,
    args: contract.args.map(toCoreDiscoveryArg),
    ...(contract.channels ? { channels: contract.channels } : {}),
  };
}

function toCoreDiscoveryArg(arg: ComputeCommandArg): CoreDiscoveryArg {
  return {
    name: arg.name,
    ...(arg.type === undefined ? {} : { type: arg.type }),
    ...(arg.default === undefined ? {} : { default: arg.default }),
    ...(arg.required === undefined ? {} : { required: arg.required }),
    ...(arg.positional === undefined ? {} : { positional: arg.positional }),
    ...(arg.choices === undefined ? {} : { choices: [...arg.choices] }),
    ...(arg.description === undefined ? {} : { description: arg.description }),
  };
}
