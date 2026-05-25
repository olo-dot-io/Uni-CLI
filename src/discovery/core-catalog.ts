/**
 * @owner   src/discovery/core-catalog.ts
 * @does    Catalog core Uni-CLI commands that are implemented by Commander modules instead of adapter manifests.
 * @needs   none
 * @feeds   src/discovery/search.ts, src/fast-path/handlers/discovery.ts, src/mcp/handler.ts, src/cli.ts
 * @breaks  Missing core rows make built-in capabilities executable but undiscoverable through search/list/MCP.
 */

import type { TargetSurface } from "../types.js";

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
  args?: readonly CoreDiscoveryArg[];
  channels?: Record<string, string>;
}

const COMPUTE_CAPTURE_ARGS: readonly CoreDiscoveryArg[] = [
  {
    name: "app",
    type: "str",
    description: "Application name to scope snapshot and screenshot capture",
  },
  {
    name: "format",
    type: "str",
    default: "compact",
    choices: ["compact", "json", "tree"],
    description: "Snapshot encoding for accessibility refs",
  },
  {
    name: "include",
    type: "str",
    default: "snapshot,screenshot",
    description: "Comma-separated capture parts: snapshot,screenshot",
  },
  {
    name: "maxDepth",
    type: "int",
    description: "Maximum accessibility tree depth",
  },
  {
    name: "screenshotPath",
    type: "str",
    description: "Optional screenshot output path",
  },
  {
    name: "saveReference",
    type: "bool",
    description: "Persist app-shot handoff artifacts",
  },
  {
    name: "copyReference",
    type: "bool",
    description: "Persist and copy app-shot handoff markup",
  },
  {
    name: "referenceRoot",
    type: "str",
    description: "Directory for saved app-shot artifacts",
  },
];

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
    site: "compute",
    command: "apps",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "List installed and visible desktop applications for local computer-use workflows.",
  },
  {
    site: "compute",
    command: "windows",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "List visible desktop windows for local computer-use workflows.",
  },
  {
    site: "compute",
    command: "snapshot",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Capture compact accessibility snapshots, refs, app state, and native UI structure for local computer-use agents.",
  },
  {
    site: "compute",
    command: "capture",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    args: COMPUTE_CAPTURE_ARGS,
    channels: {
      shell:
        "unicli compute capture [--app <name>] [--include snapshot,screenshot] [--format compact] [--copy-reference]",
      args_file: "unicli compute capture --args-file <path.json>",
      stdin: "echo '{...}' | unicli compute capture",
    },
    description:
      "Capture local computer-use context by combining accessibility refs, app state, screenshot evidence, image metadata, app-shot reference artifacts, clipboard handoff markup, and replayable capture trajectory.",
  },
  {
    site: "compute",
    command: "find",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Find a desktop UI element by query and return stable refs for local computer-use actions.",
  },
  {
    site: "compute",
    command: "click",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Click a desktop UI ref through the local computer-use cascade with action evidence.",
  },
  {
    site: "compute",
    command: "type",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Type text into a desktop UI ref through native, browser, or visual computer-use transports.",
  },
  {
    site: "compute",
    command: "press",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Press a keyboard shortcut through local computer-use transports.",
  },
  {
    site: "compute",
    command: "scroll",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Scroll a desktop UI ref through local computer-use transports.",
  },
  {
    site: "compute",
    command: "launch",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description: "Launch a desktop app before local computer-use control.",
  },
  {
    site: "compute",
    command: "screenshot",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Capture a desktop screenshot for local computer-use observation and visual fallback.",
  },
  {
    site: "compute",
    command: "attach",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Attach to a desktop app or browser-backed local runtime for computer-use actions.",
  },
  {
    site: "compute",
    command: "eval",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Evaluate JavaScript in an attached browser-backed local runtime.",
  },
  {
    site: "compute",
    command: "wait",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Wait for a local computer-use target to reach a stable or expected state.",
  },
  {
    site: "compute",
    command: "observe",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Observe desktop state against a natural-language goal using local computer-use transports.",
  },
  {
    site: "compute",
    command: "assert",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    description:
      "Assert desktop state for a local computer-use workflow and return structured evidence.",
  },
];

export function listCoreDiscoveryCommands(): CoreDiscoveryCommand[] {
  return [...CORE_DISCOVERY_COMMANDS].sort(
    (a, b) =>
      a.site.localeCompare(b.site) || a.command.localeCompare(b.command),
  );
}

export function getCoreDiscoveryCommand(
  site: string,
  command: string,
): CoreDiscoveryCommand | undefined {
  return CORE_DISCOVERY_COMMANDS.find(
    (candidate) => candidate.site === site && candidate.command === command,
  );
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
  for (const command of CORE_DISCOVERY_COMMANDS) {
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
