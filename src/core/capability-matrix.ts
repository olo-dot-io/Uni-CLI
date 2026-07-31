/**
 * @owner   src/core/capability-matrix.ts
 * @does    Builds live-catalog substrate and workflow readiness matrices for agent-to-computer control.
 * @needs   command inventory rows from src/core/architecture-tree.ts
 * @feeds   architecture tree/audit payloads and architecture regression tests.
 * @breaks  Misclassification overstates what Uni-CLI can control, especially visual or workflow coverage.
 * @invariants Readiness is catalog-derived only; live verification must be represented as required next evidence, not implied success.
 * @side-effects none
 * @perf    O(commands * surfaces + commands * workflows), bounded by catalog size.
 * @concurrency pure and reentrant.
 * @test    tests/unit/core/capability-matrix.test.ts
 * @stability experimental
 * @since   2026-05-31
 */

export const CAPABILITY_SURFACES = [
  "web",
  "browser",
  "desktop",
  "system",
  "protocol",
  "bridge",
] as const;

export type ArchitectureCapabilitySurface =
  (typeof CAPABILITY_SURFACES)[number];

export type WorkflowReadinessStatus = "cataloged" | "partial" | "gap";

export interface CapabilityMatrixInventoryEntry {
  ref: string;
  site: string;
  command: string;
  source_kind: "adapter" | "core";
  adapter_type: string;
  target_surface: string;
  category?: string;
  source_path?: string;
  safety_class: string;
  operation_effect: string;
  minimum_capability?: string;
  capabilities: readonly string[];
  uses_browser: boolean;
  is_local_computer_use: boolean;
}

export interface ArchitectureCapabilityMatrixEntry {
  surface: ArchitectureCapabilitySurface;
  command_count: number;
  adapter_commands: number;
  core_commands: number;
  write_commands: number;
  auth_or_write_commands: number;
  local_computer_use_commands: number;
  source_path_coverage: {
    present: number;
    missing: number;
  };
  representative_commands: string[];
}

export interface ArchitectureWorkflowReadiness {
  id: string;
  label: string;
  vehicle_assistant_analogy: string;
  readiness: WorkflowReadinessStatus;
  command_count: number;
  action_command_count: number;
  surfaces: ArchitectureCapabilitySurface[];
  representative_commands: string[];
  required_next_evidence: string[];
  gap?: string;
}

interface WorkflowDefinition {
  id: string;
  label: string;
  vehicle_assistant_analogy: string;
  required_next_evidence: string[];
  gap: string;
  match: (entry: CapabilityMatrixInventoryEntry) => boolean;
  isActionCommand?: (entry: CapabilityMatrixInventoryEntry) => boolean;
}

const MEDIA_SITES = new Set([
  "spotify",
  "netease-music",
  "apple-podcasts",
  "youtube",
  "yt-dlp",
]);

const VIDEO_SITES = new Set([
  "bilibili",
  "youtube",
  "tiktok",
  "douyin",
  "kuaishou",
  "yt-dlp",
]);

const BROWSER_CONTROL_SITES = new Set(["browser", "operate", "chrome"]);

const PRODUCTIVITY_SITES = new Set([
  "apple-notes",
  "notion",
  "todoist",
  "linear",
  "word",
  "powerpoint",
  "excel",
  "obsidian",
  "notebooklm",
]);

const DESTINATION_SITES = new Set([
  "browser",
  "operate",
  "chrome",
  "macos",
  "google",
  "brave",
  "duckduckgo",
  "baidu",
  "ctrip",
  "12306",
]);

const PROTOCOL_SITES = new Set([
  "agents",
  "architecture",
  "delivery",
  "mcp",
  "operate",
  "runs",
]);

const ACTION_COMMAND_TERMS = [
  "click",
  "type",
  "press",
  "scroll",
  "open",
  "launch",
  "create",
  "send",
  "set",
  "insert",
  "move",
  "copy",
  "run",
  "play",
  "control",
];

const SEARCH_OR_DISCOVERY_TERMS = [
  "search",
  "trending",
  "hot",
  "ranking",
  "top",
  "shorts",
  "playlist",
  "feed",
  "history",
  "live",
];

const WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = [
  {
    id: "media-playback",
    label: "Play or inspect media",
    vehicle_assistant_analogy: "play a song or inspect current media state",
    required_next_evidence: [
      "run the selected media command",
      "capture post-state or service response",
      "record auth and permission posture",
    ],
    gap: "no cataloged music/audio/media control path",
    match: (entry) =>
      MEDIA_SITES.has(entry.site) ||
      includesAny(entry.command, ["music", "playlist", "podcast", "audio"]),
    isActionCommand: (entry) =>
      includesAny(entry.command, ["play", "control", "now-playing"]) ||
      entry.safety_class !== "read",
  },
  {
    id: "video-search",
    label: "Search video platforms",
    vehicle_assistant_analogy:
      "search Bilibili, YouTube, TikTok, or short video feeds",
    required_next_evidence: [
      "run the search/trending command",
      "assert non-empty result envelope",
      "record auth requirement when needed",
    ],
    gap: "no cataloged video-platform search path",
    match: (entry) =>
      VIDEO_SITES.has(entry.site) &&
      includesAny(entry.command, SEARCH_OR_DISCOVERY_TERMS),
    isActionCommand: (entry) =>
      includesAny(entry.command, SEARCH_OR_DISCOVERY_TERMS),
  },
  {
    id: "browser-tab-control",
    label: "Operate browser tabs",
    vehicle_assistant_analogy:
      "navigate, inspect, and click inside the current browser",
    required_next_evidence: [
      "capture browser state before action",
      "perform one browser operation",
      "capture post-action evidence",
    ],
    gap: "no cataloged browser tab control path",
    match: (entry) =>
      BROWSER_CONTROL_SITES.has(entry.site) ||
      entry.uses_browser ||
      entry.capabilities.some((capability) =>
        capability.startsWith("cdp-browser."),
      ),
    isActionCommand: (entry) =>
      includesAny(entry.command, [
        "click",
        "bind",
        "state",
        "evidence",
        "extract",
      ]),
  },
  {
    id: "installed-app-operation",
    label: "Operate installed apps",
    vehicle_assistant_analogy:
      "open apps, inspect UI, and dispatch local actions",
    required_next_evidence: [
      "run compute or desktop app discovery",
      "resolve an accessibility or app ref",
      "verify post-action app state",
    ],
    gap: "no cataloged installed-app operation path",
    match: (entry) =>
      entry.is_local_computer_use ||
      entry.target_surface === "desktop" ||
      entry.adapter_type === "desktop",
    isActionCommand: (entry) =>
      entry.safety_class !== "read" ||
      includesAny(entry.command, ACTION_COMMAND_TERMS),
  },
  {
    id: "productivity-state",
    label: "Read and write productivity state",
    vehicle_assistant_analogy:
      "read notes/calendar/docs or create/update local productivity state",
    required_next_evidence: [
      "run read/list and one write-capable command when present",
      "capture structured envelope",
      "record local file/app permission posture",
    ],
    gap: "no cataloged productivity state path",
    match: (entry) =>
      PRODUCTIVITY_SITES.has(entry.site) ||
      includesAny(entry.command, ["notes", "calendar", "reminder", "mail"]),
    isActionCommand: (entry) =>
      entry.safety_class !== "read" ||
      includesAny(entry.command, ["create", "send", "set", "insert"]),
  },
  {
    id: "open-destination",
    label: "Open or navigate to a destination",
    vehicle_assistant_analogy:
      "navigate to a place; on a computer, open a URL, app, file, route, or travel destination",
    required_next_evidence: [
      "resolve the destination into a command and args",
      "run with policy profile",
      "capture URL/app/file/travel result evidence",
    ],
    gap: "no cataloged destination/open/navigation path",
    match: (entry) =>
      DESTINATION_SITES.has(entry.site) &&
      includesAny(entry.command, [
        "open",
        "navigate",
        "url",
        "route",
        "travel",
        "station",
        "train",
        "flight",
        "search",
      ]),
    isActionCommand: (entry) =>
      includesAny(entry.command, ["open", "navigate"]) ||
      entry.safety_class !== "read",
  },
];

export function surfacesForCapabilityEntry(
  entry: CapabilityMatrixInventoryEntry,
): ArchitectureCapabilitySurface[] {
  const surfaces = new Set<ArchitectureCapabilitySurface>();

  if (entry.target_surface === "web" || entry.adapter_type === "web-api") {
    surfaces.add("web");
  }
  if (entry.target_surface === "desktop" || entry.adapter_type === "desktop") {
    surfaces.add("desktop");
  }
  if (entry.target_surface === "system" || entry.site === "macos") {
    surfaces.add("system");
  }
  if (
    entry.uses_browser ||
    entry.adapter_type === "browser" ||
    hasCapabilityPrefix(entry, "cdp-browser.")
  ) {
    surfaces.add("browser");
  }
  if (entry.adapter_type === "bridge") {
    surfaces.add("bridge");
  }
  if (
    entry.adapter_type === "service" ||
    PROTOCOL_SITES.has(entry.site) ||
    hasCapabilityPrefix(entry, "mcp.") ||
    hasCapabilityPrefix(entry, "acp.")
  ) {
    surfaces.add("protocol");
  }

  return CAPABILITY_SURFACES.filter((surface) => surfaces.has(surface));
}

export function buildArchitectureCapabilityMatrix(
  entries: readonly CapabilityMatrixInventoryEntry[],
): ArchitectureCapabilityMatrixEntry[] {
  return CAPABILITY_SURFACES.map((surface) => {
    const matchingEntries = entries.filter((entry) =>
      surfacesForCapabilityEntry(entry).includes(surface),
    );
    const sourcePathPresent = matchingEntries.filter(
      (entry) => entry.source_path !== undefined,
    ).length;
    return {
      surface,
      command_count: matchingEntries.length,
      adapter_commands: matchingEntries.filter(
        (entry) => entry.source_kind === "adapter",
      ).length,
      core_commands: matchingEntries.filter(
        (entry) => entry.source_kind === "core",
      ).length,
      write_commands: matchingEntries.filter(
        (entry) => entry.safety_class !== "read",
      ).length,
      auth_or_write_commands: matchingEntries.filter(
        (entry) =>
          entry.safety_class === "auth_read" ||
          entry.safety_class === "write" ||
          entry.safety_class === "destructive",
      ).length,
      local_computer_use_commands: matchingEntries.filter(
        (entry) => entry.is_local_computer_use,
      ).length,
      source_path_coverage: {
        present: sourcePathPresent,
        missing: matchingEntries.length - sourcePathPresent,
      },
      representative_commands: representativeRefs(matchingEntries),
    };
  });
}

export function buildArchitectureWorkflowReadiness(
  entries: readonly CapabilityMatrixInventoryEntry[],
): ArchitectureWorkflowReadiness[] {
  return WORKFLOW_DEFINITIONS.map((workflow) => {
    const matchingEntries = entries
      .filter((entry) => workflow.match(entry))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const actionEntries = matchingEntries.filter((entry) =>
      (workflow.isActionCommand ?? defaultIsActionCommand)(entry),
    );
    const surfaces = Array.from(
      new Set(
        matchingEntries.flatMap((entry) => surfacesForCapabilityEntry(entry)),
      ),
    ).sort((left, right) => surfaceRank(left) - surfaceRank(right));
    const readiness = workflowReadiness(matchingEntries, actionEntries);

    return {
      id: workflow.id,
      label: workflow.label,
      vehicle_assistant_analogy: workflow.vehicle_assistant_analogy,
      readiness,
      command_count: matchingEntries.length,
      action_command_count: actionEntries.length,
      surfaces,
      representative_commands: workflowRepresentativeRefs(
        matchingEntries,
        actionEntries,
      ),
      required_next_evidence: workflow.required_next_evidence,
      ...(readiness === "gap" ? { gap: workflow.gap } : {}),
    };
  });
}

function workflowReadiness(
  matchingEntries: readonly CapabilityMatrixInventoryEntry[],
  actionEntries: readonly CapabilityMatrixInventoryEntry[],
): WorkflowReadinessStatus {
  if (matchingEntries.length === 0) return "gap";
  if (actionEntries.length === 0) return "partial";
  return "cataloged";
}

function defaultIsActionCommand(
  entry: CapabilityMatrixInventoryEntry,
): boolean {
  return (
    entry.safety_class !== "read" ||
    includesAny(entry.command, ACTION_COMMAND_TERMS)
  );
}

function representativeRefs(
  entries: readonly CapabilityMatrixInventoryEntry[],
): string[] {
  return entries
    .map((entry) => entry.ref)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 8);
}

function workflowRepresentativeRefs(
  matchingEntries: readonly CapabilityMatrixInventoryEntry[],
  actionEntries: readonly CapabilityMatrixInventoryEntry[],
): string[] {
  const seen = new Set<string>();
  const orderedEntries = [...actionEntries, ...matchingEntries].filter(
    (entry) => {
      if (seen.has(entry.ref)) return false;
      seen.add(entry.ref);
      return true;
    },
  );
  return orderedEntries.map((entry) => entry.ref).slice(0, 8);
}

function hasCapabilityPrefix(
  entry: CapabilityMatrixInventoryEntry,
  prefix: string,
): boolean {
  return entry.capabilities.some((capability) => capability.startsWith(prefix));
}

function includesAny(text: string, terms: readonly string[]): boolean {
  const lowerText = text.toLowerCase();
  return terms.some((term) => lowerText.includes(term));
}

function surfaceRank(surface: ArchitectureCapabilitySurface): number {
  return CAPABILITY_SURFACES.indexOf(surface);
}
