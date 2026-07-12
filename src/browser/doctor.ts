/**
 * @owner   src/browser/doctor.ts
 * @does    Build a machine-readable browser reliability report from live daemon, profile, CDP, layering, repair, and retry state.
 * @needs   src/browser local-profiles/profile-seed/launcher/cdp-client/daemon-client/bridge/protocol
 * @feeds   src/commands/browser/index.ts, tests/unit/commands/browser.test.ts
 * @breaks  Probe failures are returned as diagnostics in the report; raw cookies, auth headers, and endpoint secrets are never emitted.
 * @invariants Doctor reports whether the default browser path is attach, seeded, ephemeral, or unverified; it never reports raw cookie values or prescribes adapter repair for browser availability.
 * @side-effects Optional repair may launch Chrome through src/browser/launcher.ts; report-only mode performs bounded reads/probes.
 * @perf    Probes use short network and daemon timeouts.
 * @concurrency Does not mutate profile seed state except through explicit repair; launcher owns seed locks.
 * @test    tests/unit/commands/browser.test.ts
 * @stability experimental
 * @since   2026-06-29
 */

import {
  automationDefaultUserDataDir,
  automationUserDataDirForProfile,
  detectDefaultProfileDebugBlocks,
  detectLocalBrowserProfiles,
  isProcessVerifiedDebugPort,
  readProcessDebugTargetForPort,
  readUserDataDirDebugPort,
  resolvePreferredLocalBrowserProfile,
  type DefaultProfileDebugBlock,
  type LocalBrowserProfile,
} from "./local-profiles.js";
import {
  inspectAutomationProfileSeed,
  isBrowserEphemeralRequested,
  isEphemeralAutomationUserDataDir,
  isRunningSeedIdentityUsable,
  type AutomationProfileSeedInspection,
} from "./profile-seed.js";
import { getCDPPort, isCDPAvailable, launchChrome } from "./launcher.js";
import { getRemoteEndpoint } from "./cdp-client.js";
import {
  BROWSER_DAEMON_COMMAND_MAX_ATTEMPTS,
  BROWSER_DAEMON_EXTENSION_RETRY_DELAY_MS,
  BROWSER_DAEMON_NETWORK_RETRY_DELAY_MS,
  fetchDaemonPortConflict,
  fetchDaemonStatus,
  listSessions,
} from "./daemon-client.js";
import {
  BROWSER_REMOTE_CONNECT_MAX_ATTEMPTS,
  BROWSER_REMOTE_RETRY_DELAY_MS,
} from "./bridge.js";
import {
  MAX_EAGER_RECONNECT_ATTEMPTS,
  WS_RECONNECT_BASE_DELAY,
  WS_RECONNECT_MAX_DELAY,
  type BrowserSessionInfo,
  type DaemonStatus,
} from "./protocol.js";
import {
  buildChrome136RemoteDebuggingGuidance,
  detectChromeRemoteDebuggingPolicy,
  type Chrome136RemoteDebuggingGuidance,
  type ChromeRemoteDebuggingPolicyReport,
} from "./chrome-policy.js";

export type BrowserDoctorStatus = "ready" | "needs-action";
export type BrowserCapabilityId =
  | "cookie_reuse"
  | "background_operation"
  | "browser_use"
  | "page_layering"
  | "direct_connect"
  | "stability"
  | "reliability"
  | "repair"
  | "retry";
export type BrowserCapabilityStatus = "ready" | "needs-action";

const REQUIRED_BROWSER_CAPABILITIES: BrowserCapabilityId[] = [
  "cookie_reuse",
  "background_operation",
  "browser_use",
  "page_layering",
  "direct_connect",
  "stability",
  "reliability",
  "repair",
  "retry",
];

interface DoctorProbe<T> {
  value: T;
  error?: string;
}

export interface BrowserCapabilityCheck {
  status: BrowserCapabilityStatus;
  evidence: string[];
  repair_commands: string[];
  diagnostics?: string[];
}

export interface BrowserDoctorCheck {
  name: string;
  ok: boolean;
  status: BrowserCapabilityStatus;
  detail: string;
  next_step: string;
  commands?: string[];
  evidence?: string[];
  auto_repairable?: boolean;
}

export interface BrowserSelfRepairAction {
  id: string;
  status: "available" | "not-needed" | "manual" | "blocked";
  command: string;
  safe: boolean;
  detail: string;
  expected_result: string;
}

export interface BrowserRepairAttempt {
  status: "repaired" | "already-ready" | "failed";
  actions: Array<{
    id: string;
    status: "repaired" | "skipped" | "failed";
    command: string;
    detail: string;
  }>;
}

export interface BrowserProfileSourceReport {
  source: "attach" | "seeded" | "ephemeral" | "missing-profile" | "unverified";
  mode:
    | "remote-cdp"
    | "live-profile-attach"
    | "seeded-automation-profile"
    | "empty-temporary-profile"
    | "none"
    | "unverified-local-cdp";
  ready: boolean;
  warning?: string;
  port?: number;
  profile?: {
    id: string;
    browser_name: string;
    profile_dir: string;
    profile_name: string;
    debug_port_state: string;
  };
  automation_user_data_dir?: string;
  seed?: AutomationProfileSeedInspection;
}

export interface BrowserDoctorReport {
  status: BrowserDoctorStatus;
  cookie_reuse: {
    status: "ready" | "needs-profile";
    profiles_count: number;
    raw_cookie_values_returned: false;
    raw_cookie_export_supported: true;
    direct_browser_cookie_import_supported: true;
    command: "unicli browser profiles --json";
    direct_browser_cookie_import_command: "unicli auth import <site> --domain <domain> --browser <id> --profile <name>";
    explicit_cookie_export_command: "unicli browser cookies <domain> --profile-id <id>";
    strategy: string[];
    reuse_paths: string[];
    profiles: Array<{
      id: string;
      browser_name: string;
      profile_dir: string;
      profile_name: string;
      debug_port_state: string;
    }>;
  };
  background_operation: {
    status: "ready" | "needs-extension" | "stopped" | "blocked";
    daemon: {
      status: "running" | "stopped" | "blocked";
      port?: number;
      extension_connected: boolean;
      pending?: number;
      memory_mb?: number;
      conflict?: string;
      error?: string;
    };
    sessions_count: number;
    session_error?: string;
    controls: string[];
  };
  browser_use: {
    modes: string[];
    layers: Array<{
      name: string;
      owner: string;
      proves: string;
    }>;
  };
  direct_connect: {
    local_cdp: {
      port: number;
      reachable: boolean;
      identity_verified: boolean;
      command: "unicli browser start";
      error?: string;
    };
    remote_cdp: {
      configured: boolean;
      endpoint?: string;
      header_count: number;
    };
  };
  chrome_remote_debugging: {
    chrome_136: Chrome136RemoteDebuggingGuidance;
    policy: ChromeRemoteDebuggingPolicyReport;
  };
  stability_reliability: {
    guards: string[];
    evidence: string[];
    background_safe: boolean;
  };
  repair_retry: {
    retry_policy: Array<{
      surface: string;
      max_attempts: number;
      retry_delay_ms?: number;
      network_retry_delay_ms?: number;
      extension_retry_delay_ms?: number;
      min_delay_ms?: number;
      max_delay_ms?: number;
    }>;
    recovery_commands: string[];
  };
  default_path: {
    status: "ready" | "needs-action";
    mode:
      | "local-cdp-automation-profile"
      | "live-profile-attach"
      | "seeded-automation-profile"
      | "ephemeral-profile"
      | "unverified-local-cdp"
      | "remote-cdp"
      | "daemon-extension"
      | "none";
    ready: boolean;
    next_step: string;
    commands: string[];
    detail: string;
  };
  profile_source: BrowserProfileSourceReport;
  checks: BrowserDoctorCheck[];
  self_repair: {
    safe_command: "unicli browser doctor --repair";
    actions: BrowserSelfRepairAction[];
  };
  repair_attempt?: BrowserRepairAttempt;
  next_actions: string[];
  completeness: {
    complete: boolean;
    required_capabilities: BrowserCapabilityId[];
    missing: BrowserCapabilityId[];
    matrix: Record<BrowserCapabilityId, BrowserCapabilityCheck>;
  };
}

export async function runBrowserDoctor(
  repairAttempt?: BrowserRepairAttempt,
): Promise<BrowserDoctorReport> {
  const profiles = detectLocalBrowserProfiles();
  const defaultProfileDebugBlocks = detectDefaultProfileDebugBlocks();
  const remoteDebuggingPolicy = detectChromeRemoteDebuggingPolicy();
  const chrome136Guidance = buildChrome136RemoteDebuggingGuidance();
  const daemonProbe = await probeDaemon();
  const daemonStatus = daemonProbe.value;
  const conflict =
    daemonStatus === null
      ? await probeDaemonPortConflict()
      : ({ value: null } satisfies DoctorProbe<string | null>);
  const sessionsProbe =
    daemonStatus?.extensionConnected === true
      ? await probeSessions()
      : ({ value: [] } satisfies DoctorProbe<BrowserSessionInfo[]>);
  const localCdp = await probeLocalCdp();
  const remote = getRemoteEndpoint();
  const profileSource = await buildProfileSourceReport(
    profiles,
    remote !== null,
  );
  const localCdpIdentityVerified =
    profileSource.ready &&
    (profileSource.mode === "live-profile-attach" ||
      profileSource.mode === "seeded-automation-profile" ||
      profileSource.mode === "empty-temporary-profile");

  const backgroundStatus = buildBackgroundStatus(daemonStatus, conflict.value);
  const isAutomationReady = backgroundStatus === "ready" || profileSource.ready;
  const cookieReuse = buildCookieReuse(profiles);
  const backgroundOperation: BrowserDoctorReport["background_operation"] = {
    status: backgroundStatus,
    daemon: buildDaemonReport(
      daemonStatus,
      conflict.value,
      daemonProbe.error ?? conflict.error,
    ),
    sessions_count: sessionsProbe.value.length,
    ...(sessionsProbe.error ? { session_error: sessionsProbe.error } : {}),
    controls: [
      "default windowFocused=false",
      "browser start uses --no-startup-window by default",
      "--background",
      "--focus",
      "--workspace",
      "--isolated",
      "--shared-session",
      "--daemon-port",
    ],
  };
  const browserUse: BrowserDoctorReport["browser_use"] = {
    modes: ["logged-in Chrome", "headless Chrome", "remote CDP cloud browser"],
    layers: [
      {
        name: "runtime-control",
        owner: "src/commands/browser/actions.ts",
        proves:
          "CLI options route focus, workspace, and background intent before browser work starts.",
      },
      {
        name: "browser-session",
        owner: "src/browser/bridge.ts",
        proves:
          "Daemon, extension, local CDP, and remote CDP connection paths are explicit.",
      },
      {
        name: "page-state",
        owner: "src/browser/page.ts",
        proves:
          "DOM, frame, network, screenshot, and CDP operations are page-scoped.",
      },
      {
        name: "evidence-repair",
        owner: "src/engine/browser/evidence.ts",
        proves:
          "Before/after evidence, movement checks, and repair commands are serialized for agents.",
      },
    ],
  };
  const directConnect: BrowserDoctorReport["direct_connect"] = {
    local_cdp: {
      port: getCDPPort(),
      reachable: localCdp.value,
      identity_verified: localCdpIdentityVerified,
      command: "unicli browser start",
      ...(localCdp.error ? { error: localCdp.error } : {}),
    },
    remote_cdp: {
      configured: remote !== null,
      ...(remote ? { endpoint: redactEndpoint(remote.endpoint) } : {}),
      header_count: remote ? Object.keys(remote.headers).length : 0,
    },
  };
  const chromeRemoteDebugging: BrowserDoctorReport["chrome_remote_debugging"] =
    {
      chrome_136: chrome136Guidance,
      policy: remoteDebuggingPolicy,
    };
  const stabilityReliability: BrowserDoctorReport["stability_reliability"] = {
    guards: [
      "non-focusing daemon command default",
      "no-startup-window local Chrome launch",
      "doctor sessions probe does not create placeholder tabs",
      "workspace lease",
      "target lease",
      "domain/path guard",
      "render stability probe",
      "action movement watchdog",
      "Chrome 136+ non-default user-data-dir requirement",
    ],
    evidence: [
      "DOM snapshot",
      "screenshot",
      "network",
      "console",
      "frame tree",
    ],
    background_safe: true,
  };
  const repairRetry: BrowserDoctorReport["repair_retry"] = {
    retry_policy: [
      {
        surface: "daemon-command",
        max_attempts: BROWSER_DAEMON_COMMAND_MAX_ATTEMPTS,
        network_retry_delay_ms: BROWSER_DAEMON_NETWORK_RETRY_DELAY_MS,
        extension_retry_delay_ms: BROWSER_DAEMON_EXTENSION_RETRY_DELAY_MS,
      },
      {
        surface: "remote-cdp",
        max_attempts: BROWSER_REMOTE_CONNECT_MAX_ATTEMPTS,
        retry_delay_ms: BROWSER_REMOTE_RETRY_DELAY_MS,
      },
      {
        surface: "extension-websocket",
        max_attempts: MAX_EAGER_RECONNECT_ATTEMPTS,
        min_delay_ms: WS_RECONNECT_BASE_DELAY,
        max_delay_ms: WS_RECONNECT_MAX_DELAY,
      },
    ],
    recovery_commands: [
      "unicli browser profiles --json",
      "unicli auth import <site> --domain <domain>",
      "unicli browser cookies <domain> --profile-id <id>",
      "unicli browser start",
      "unicli browser bind",
      "unicli browser evidence --render-aware",
    ],
  };
  const nextActions = buildNextActions(
    profiles,
    backgroundStatus,
    localCdp.value,
    remote !== null,
    remoteDebuggingPolicy,
  );
  const defaultPath = buildDefaultPath({
    profiles,
    backgroundOperation,
    directConnect,
    cookieReuse,
    profileSource,
  });
  const checks = buildChecks({
    profiles,
    cookieReuse,
    backgroundOperation,
    directConnect,
    defaultProfileDebugBlocks,
    remoteDebuggingPolicy,
    chrome136Guidance,
  });
  const selfRepair = buildSelfRepair({
    profiles,
    backgroundOperation,
    directConnect,
    defaultProfileDebugBlocks,
    remoteDebuggingPolicy,
  });

  return {
    status: isAutomationReady ? "ready" : "needs-action",
    cookie_reuse: cookieReuse,
    background_operation: backgroundOperation,
    browser_use: browserUse,
    direct_connect: directConnect,
    chrome_remote_debugging: chromeRemoteDebugging,
    stability_reliability: stabilityReliability,
    repair_retry: repairRetry,
    default_path: defaultPath,
    profile_source: profileSource,
    checks,
    self_repair: selfRepair,
    ...(repairAttempt ? { repair_attempt: repairAttempt } : {}),
    next_actions: nextActions,
    completeness: buildCompleteness({
      cookieReuse,
      backgroundOperation,
      browserUse,
      directConnect,
      stabilityReliability,
      repairRetry,
    }),
  };
}

export async function repairBrowserDoctor(): Promise<BrowserRepairAttempt> {
  const policy = detectChromeRemoteDebuggingPolicy();
  if (policy.state === "disabled") {
    return {
      status: "failed",
      actions: [
        {
          id: "enable-remote-debugging-policy",
          status: "failed",
          command: policy.next_step,
          detail:
            "Chrome policy RemoteDebuggingAllowed=false blocks local CDP. Uni-CLI will not try unsupported feature-flag bypasses.",
        },
      ],
    };
  }
  const port = getCDPPort();
  const remote = getRemoteEndpoint();
  const profileSource = await buildProfileSourceReport(
    detectLocalBrowserProfiles(),
    remote !== null,
  );
  if (
    profileSource.ready &&
    (profileSource.mode === "live-profile-attach" ||
      profileSource.mode === "seeded-automation-profile" ||
      profileSource.mode === "remote-cdp")
  ) {
    return {
      status: "already-ready",
      actions: [
        {
          id: "start-local-automation-cdp",
          status: "skipped",
          command: "unicli browser start",
          detail:
            profileSource.mode === "remote-cdp"
              ? "Remote CDP is configured and verified as the default browser path."
              : `Local CDP identity is already verified on port ${String(profileSource.port ?? port)}.`,
        },
      ],
    };
  }

  try {
    const actualPort = await launchChrome(port);
    return {
      status: "repaired",
      actions: [
        {
          id: "start-local-automation-cdp",
          status: "repaired",
          command: "unicli browser start",
          detail: `Started Uni-CLI automation Chrome CDP on port ${String(actualPort)}.`,
        },
      ],
    };
  } catch (err) {
    return {
      status: "failed",
      actions: [
        {
          id: "start-local-automation-cdp",
          status: "failed",
          command: "unicli browser start",
          detail: errorMessage(err),
        },
      ],
    };
  }
}

async function probeDaemon(): Promise<DoctorProbe<DaemonStatus | null>> {
  try {
    return { value: await fetchDaemonStatus({ timeout: 1000 }) };
  } catch (err) {
    return { value: null, error: errorMessage(err) };
  }
}

async function probeDaemonPortConflict(): Promise<DoctorProbe<string | null>> {
  try {
    return { value: await fetchDaemonPortConflict({ timeout: 1000 }) };
  } catch (err) {
    return { value: null, error: errorMessage(err) };
  }
}

async function probeSessions(): Promise<DoctorProbe<BrowserSessionInfo[]>> {
  try {
    return { value: await listSessions() };
  } catch (err) {
    return { value: [], error: errorMessage(err) };
  }
}

async function probeLocalCdp(): Promise<DoctorProbe<boolean>> {
  try {
    return { value: await isCDPAvailable(getCDPPort()) };
  } catch (err) {
    return { value: false, error: errorMessage(err) };
  }
}

function buildCookieReuse(
  profiles: LocalBrowserProfile[],
): BrowserDoctorReport["cookie_reuse"] {
  return {
    status: profiles.length > 0 ? "ready" : "needs-profile",
    profiles_count: profiles.length,
    raw_cookie_values_returned: false as const,
    raw_cookie_export_supported: true as const,
    direct_browser_cookie_import_supported: true as const,
    command: "unicli browser profiles --json" as const,
    direct_browser_cookie_import_command:
      "unicli auth import <site> --domain <domain> --browser <id> --profile <name>" as const,
    explicit_cookie_export_command:
      "unicli browser cookies <domain> --profile-id <id>" as const,
    strategy: [
      "import domain cookies from the selected local browser DB when platform decryption is available",
      "prefer a live CDP process whose --user-data-dir matches the selected profile",
      "launch Chrome CDP with a Uni-CLI automation profile instead of the default user-data-dir",
      "inject selected local profile cookies into the automation profile for browserSession=user commands",
      "extract raw domain cookies through explicit user-requested CDP export",
    ],
    reuse_paths: [
      "direct browser DB cookie import",
      "process-verified live profile CDP",
      "automation profile launch under ~/.unicli",
      "selected profile cookie injection into CDP automation profile",
      "explicit raw cookie export through browser cookies",
      "profile discovery without returning raw cookie values",
    ],
    profiles: profiles.slice(0, 20).map((profile) => ({
      id: profile.id,
      browser_name: profile.browser_name,
      profile_dir: profile.profile_dir,
      profile_name: profile.profile_name,
      debug_port_state: profile.debug_port.state,
    })),
  };
}

function buildBackgroundStatus(
  daemon: DaemonStatus | null,
  conflict: string | null,
): BrowserDoctorReport["background_operation"]["status"] {
  if (daemon?.extensionConnected) return "ready";
  if (daemon) return "needs-extension";
  if (conflict) return "blocked";
  return "stopped";
}

function buildDaemonReport(
  daemon: DaemonStatus | null,
  conflict: string | null,
  error?: string,
): BrowserDoctorReport["background_operation"]["daemon"] {
  if (!daemon) {
    return {
      status: conflict ? "blocked" : "stopped",
      extension_connected: false,
      ...(conflict ? { conflict } : {}),
      ...(error ? { error } : {}),
    };
  }
  return {
    status: "running",
    port: daemon.port,
    extension_connected: daemon.extensionConnected,
    pending: daemon.pending,
    memory_mb: daemon.memoryMB,
    ...(error ? { error } : {}),
  };
}

function buildNextActions(
  profiles: LocalBrowserProfile[],
  backgroundStatus: BrowserDoctorReport["background_operation"]["status"],
  localCdpReachable: boolean,
  remoteConfigured: boolean,
  remoteDebuggingPolicy: ChromeRemoteDebuggingPolicyReport,
): string[] {
  const commands: string[] = [];
  if (remoteDebuggingPolicy.state === "disabled") {
    commands.push(remoteDebuggingPolicy.next_step);
  }
  if (profiles.length === 0) commands.push("unicli browser profiles --json");
  else {
    commands.push("unicli auth import <site> --domain <domain>");
    commands.push("unicli browser cookies <domain> --profile-id <id>");
  }
  if (backgroundStatus !== "ready") commands.push("unicli browser start");
  if (backgroundStatus === "needs-extension") {
    commands.push("unicli browser bind");
  }
  if (!localCdpReachable && !remoteConfigured) {
    commands.push("unicli browser remote --status");
  }
  commands.push("unicli browser evidence --render-aware");
  return [...new Set(commands)];
}

async function buildProfileSourceReport(
  profiles: LocalBrowserProfile[],
  remoteConfigured: boolean,
): Promise<BrowserProfileSourceReport> {
  const cdpPort = getCDPPort();
  const processTarget = readProcessDebugTargetForPort(cdpPort);
  if (
    processTarget &&
    isEphemeralAutomationUserDataDir(processTarget.user_data_dir) &&
    (await isCDPAvailable(processTarget.port))
  ) {
    return {
      source: "ephemeral",
      mode: "empty-temporary-profile",
      ready: true,
      port: processTarget.port,
      automation_user_data_dir: processTarget.user_data_dir,
      warning:
        "This CDP port belongs to an explicit ephemeral empty profile; logged-in cookies are intentionally not seeded.",
    };
  }
  if (isBrowserEphemeralRequested(process.env)) {
    return {
      source: "ephemeral",
      mode: "empty-temporary-profile",
      ready: false,
      warning:
        "UNICLI_BROWSER_EPHEMERAL=1 forces an empty profile; logged-in cookies are intentionally not seeded.",
    };
  }
  if (remoteConfigured) {
    return {
      source: "attach",
      mode: "remote-cdp",
      ready: true,
    };
  }

  const profile = resolvePreferredLocalBrowserProfile() ?? profiles[0] ?? null;
  const defaultTargetUserDataDir = automationDefaultUserDataDir();
  if (!profile || profiles.length === 0) {
    return {
      source: "missing-profile",
      mode: "none",
      ready: false,
      automation_user_data_dir: defaultTargetUserDataDir,
      warning:
        "No local browser profile source was found; default startup will fail unless --ephemeral is explicit.",
    };
  }

  const profileSummary = (candidate: LocalBrowserProfile) => ({
    id: candidate.id,
    browser_name: candidate.browser_name,
    profile_dir: candidate.profile_dir,
    profile_name: candidate.profile_name,
    debug_port_state: candidate.debug_port.state,
  });
  const liveProfile = profiles.find((candidate) =>
    isProcessVerifiedDebugPort(candidate.debug_port),
  );
  if (liveProfile) {
    const livePort = await liveProfilePort(liveProfile.user_data_dir);
    if (livePort !== null) {
      return {
        source: "attach",
        mode: "live-profile-attach",
        ready: true,
        port: livePort,
        profile: profileSummary(liveProfile),
      };
    }
  }

  const liveSeed = statusSeedCandidates(profile, profiles).find((candidate) => {
    const debugPort = readUserDataDirDebugPort(candidate.targetUserDataDir);
    return isProcessVerifiedDebugPort(debugPort);
  });
  if (liveSeed) {
    const liveSeededPort = await liveProfilePort(liveSeed.targetUserDataDir);
    const seed = inspectAutomationProfileSeed(
      liveSeed.profile,
      liveSeed.targetUserDataDir,
    );
    if (liveSeededPort !== null && isRunningSeedIdentityUsable(seed)) {
      return {
        source: "seeded",
        mode: "seeded-automation-profile",
        ready: true,
        port: liveSeededPort,
        profile: profileSummary(liveSeed.profile),
        automation_user_data_dir: liveSeed.targetUserDataDir,
        seed,
        warning:
          seed.status === "fresh"
            ? undefined
            : `Automation profile is running but seed status is ${seed.status}: ${seedWarningReason(seed.reason)}.`,
      };
    }
    if (liveSeededPort !== null) {
      return {
        source: "seeded",
        mode: "unverified-local-cdp",
        ready: false,
        port: liveSeededPort,
        profile: profileSummary(liveSeed.profile),
        automation_user_data_dir: liveSeed.targetUserDataDir,
        seed,
        warning:
          "A local CDP browser is running from the automation profile, but Uni-CLI cannot prove it was seeded from the selected profile.",
      };
    }
  }

  const seed = inspectAutomationProfileSeed(profile, defaultTargetUserDataDir);
  if (seed.status === "fresh") {
    return {
      source: "seeded",
      mode: "seeded-automation-profile",
      ready: false,
      profile: profileSummary(profile),
      automation_user_data_dir: defaultTargetUserDataDir,
      seed,
      warning:
        "Automation profile is seeded but no verified local CDP process is currently running.",
    };
  }

  return {
    source: "seeded",
    mode: "seeded-automation-profile",
    ready: false,
    profile: profileSummary(profile),
    automation_user_data_dir: defaultTargetUserDataDir,
    seed,
    warning:
      "Automation profile must be seeded before default browser startup is ready.",
  };
}

function statusSeedCandidates(
  preferredProfile: LocalBrowserProfile,
  profiles: LocalBrowserProfile[],
): Array<{ profile: LocalBrowserProfile; targetUserDataDir: string }> {
  const candidates = [
    {
      profile: preferredProfile,
      targetUserDataDir: automationDefaultUserDataDir(),
    },
  ];
  const seen = new Set(
    candidates.map((candidate) => candidate.targetUserDataDir),
  );
  for (const profile of profiles) {
    const targetUserDataDir = automationUserDataDirForProfile(profile);
    if (seen.has(targetUserDataDir)) continue;
    seen.add(targetUserDataDir);
    candidates.push({ profile, targetUserDataDir });
  }
  return candidates;
}

function seedWarningReason(reason: string | undefined): string {
  return (reason ?? "seed manifest is not fresh").replace(/\.+$/, "");
}

async function liveProfilePort(userDataDir: string): Promise<number | null> {
  const debugPort = readUserDataDirDebugPort(userDataDir);
  if (
    !isProcessVerifiedDebugPort(debugPort) ||
    typeof debugPort.port !== "number" ||
    !(await isCDPAvailable(debugPort.port))
  ) {
    return null;
  }
  return debugPort.port;
}

function buildDefaultPath(input: {
  profiles: LocalBrowserProfile[];
  backgroundOperation: BrowserDoctorReport["background_operation"];
  directConnect: BrowserDoctorReport["direct_connect"];
  cookieReuse: BrowserDoctorReport["cookie_reuse"];
  profileSource: BrowserProfileSourceReport;
}): BrowserDoctorReport["default_path"] {
  if (input.profileSource.mode === "remote-cdp") {
    return {
      status: "ready",
      mode: "remote-cdp",
      ready: true,
      next_step: "Run the requested Uni-CLI command.",
      commands: [
        "unicli browser remote --status",
        "unicli <site> <command> -f json",
      ],
      detail: "Remote CDP is configured and browser commands attach to it.",
    };
  }
  if (input.profileSource.mode === "live-profile-attach") {
    return {
      status: "ready",
      mode: "live-profile-attach",
      ready: true,
      next_step: "Run the requested Uni-CLI command.",
      commands: [
        "unicli browser profiles --json",
        "unicli <site> <command> -f json",
      ],
      detail:
        "Default browser commands attach to a live local browser profile with CDP already exposed.",
    };
  }
  if (
    input.profileSource.mode === "seeded-automation-profile" &&
    input.profileSource.ready
  ) {
    return {
      status: "ready",
      mode: "seeded-automation-profile",
      ready: true,
      next_step: "Run the requested Uni-CLI command.",
      commands: [
        "unicli browser doctor --json",
        "unicli <site> <command> -f json",
      ],
      detail:
        "Default browser commands use a Uni-CLI automation profile seeded from the preferred logged-in browser profile.",
    };
  }
  if (input.profileSource.source === "ephemeral") {
    return {
      status: input.directConnect.local_cdp.reachable
        ? "ready"
        : "needs-action",
      mode: "ephemeral-profile",
      ready: input.directConnect.local_cdp.reachable,
      next_step: input.directConnect.local_cdp.reachable
        ? "Run the requested Uni-CLI command."
        : "unicli browser start --ephemeral",
      commands: [
        "unicli browser start --ephemeral",
        "unicli <site> <command> -f json",
      ],
      detail:
        "Ephemeral mode intentionally uses an empty temporary profile; logged-in cookies are not reused.",
    };
  }
  if (input.backgroundOperation.status === "ready") {
    return {
      status: "ready",
      mode: "daemon-extension",
      ready: true,
      next_step: "Run the requested browser command.",
      commands: [
        "unicli browser sessions",
        "unicli browser open <url>",
        "unicli <site> <command> -f json",
      ],
      detail: "Daemon and extension are connected for background tab control.",
    };
  }
  if (
    input.directConnect.local_cdp.reachable &&
    !input.directConnect.local_cdp.identity_verified
  ) {
    return {
      status: "needs-action",
      mode: "unverified-local-cdp",
      ready: false,
      next_step:
        "Stop the unverified automation Chrome and rerun `unicli browser start`.",
      commands: [
        "unicli browser start",
        "unicli browser profiles --json",
        "unicli browser doctor --json",
      ],
      detail:
        input.profileSource.warning ??
        "Local CDP is reachable, but doctor cannot prove it is attach or seeded.",
    };
  }
  const commands = ["unicli browser doctor --repair"];
  if (input.profiles.length === 0)
    commands.push("unicli browser profiles --json");
  if (input.cookieReuse.status !== "ready") {
    commands.push("unicli auth import <site> --domain <domain>");
  }
  commands.push("unicli browser doctor --json");
  return {
    status: "needs-action",
    mode: "none",
    ready: false,
    next_step: commands[0],
    commands,
    detail:
      "No default browser delivery path is currently reachable. Run the safe repair command first.",
  };
}

function buildChecks(input: {
  profiles: LocalBrowserProfile[];
  cookieReuse: BrowserDoctorReport["cookie_reuse"];
  backgroundOperation: BrowserDoctorReport["background_operation"];
  directConnect: BrowserDoctorReport["direct_connect"];
  defaultProfileDebugBlocks: DefaultProfileDebugBlock[];
  remoteDebuggingPolicy: ChromeRemoteDebuggingPolicyReport;
  chrome136Guidance: Chrome136RemoteDebuggingGuidance;
}): BrowserDoctorCheck[] {
  const localCdpReady = input.directConnect.local_cdp.identity_verified;
  const hasDefaultBrowserPath =
    localCdpReady || input.backgroundOperation.status === "ready";
  const remoteConfigured = input.directConnect.remote_cdp.configured;
  return [
    {
      name: "Chrome 136+ remote debugging hardening",
      ok: true,
      status: "ready",
      detail:
        "Official Chrome behavior: default user-data-dir cannot expose CDP; supported repair is a non-default automation profile, Chrome for Testing/Chromium, extension bridge, or remote CDP.",
      next_step: "unicli browser doctor --repair",
      commands: [
        input.chrome136Guidance.safe_command,
        "unicli auth import <site> --domain <domain>",
        "unicli browser profiles --json",
      ],
      evidence: [
        `default_user_data_dir_cdp_supported=${String(input.chrome136Guidance.default_user_data_dir_cdp_supported)}`,
        `policy_can_bypass_default_user_data_dir=${String(input.chrome136Guidance.policy_can_bypass_default_user_data_dir)}`,
        ...input.chrome136Guidance.official_docs,
      ],
    },
    {
      name: "remote debugging policy",
      ok: input.remoteDebuggingPolicy.state !== "disabled",
      status:
        input.remoteDebuggingPolicy.state === "disabled"
          ? "needs-action"
          : "ready",
      detail: input.remoteDebuggingPolicy.detail,
      next_step: input.remoteDebuggingPolicy.next_step,
      commands: input.remoteDebuggingPolicy.commands,
      evidence: [
        `RemoteDebuggingAllowed=${input.remoteDebuggingPolicy.state}`,
        `source=${input.remoteDebuggingPolicy.source}`,
        ...input.remoteDebuggingPolicy.official_docs,
      ],
      auto_repairable: false,
    },
    {
      name: "runtime state",
      ok: true,
      status: "ready",
      detail: "Uni-CLI browser runtime is available.",
      next_step: "No action.",
    },
    {
      name: "local browser profiles",
      ok: input.profiles.length > 0,
      status: input.profiles.length > 0 ? "ready" : "needs-action",
      detail:
        input.profiles.length > 0
          ? `${String(input.profiles.length)} local Chromium-family profile(s) discovered without returning raw cookie values.`
          : "No local Chromium-family profiles were discovered.",
      next_step:
        input.profiles.length > 0
          ? "unicli browser profiles --json"
          : "Open a Chromium-family browser once, then run `unicli browser profiles --json`.",
      commands: ["unicli browser profiles --json"],
    },
    {
      name: "cookie reuse",
      ok: input.cookieReuse.status === "ready",
      status: input.cookieReuse.status === "ready" ? "ready" : "needs-action",
      detail:
        input.cookieReuse.status === "ready"
          ? "Cookie reuse can import from local browser DBs and explicit cookie export."
          : "Cookie reuse has no discovered local profile source.",
      next_step:
        input.cookieReuse.status === "ready"
          ? "unicli auth import <site> --domain <domain>"
          : "unicli browser profiles --json",
      commands: [
        "unicli auth import <site> --domain <domain>",
        "unicli browser cookies <domain> --profile-id <id>",
      ],
    },
    {
      name: "default profile CDP trap",
      ok: input.defaultProfileDebugBlocks.length === 0,
      status:
        input.defaultProfileDebugBlocks.length === 0 ? "ready" : "needs-action",
      detail:
        input.defaultProfileDebugBlocks.length === 0
          ? "No Chrome process was detected trying to expose CDP from a default user-data-dir."
          : `${String(input.defaultProfileDebugBlocks.length)} Chrome process(es) use --remote-debugging-port with a default user-data-dir. Chrome 136+ blocks that port; no supported policy or feature flag makes that default profile CDP path reliable.`,
      next_step:
        input.defaultProfileDebugBlocks.length === 0
          ? "No action."
          : "unicli browser doctor --repair",
      commands:
        input.defaultProfileDebugBlocks.length === 0
          ? []
          : ["unicli browser doctor --repair"],
      evidence: input.defaultProfileDebugBlocks.map(
        (block) =>
          `pid=${String(block.pid)} ${block.browser_name} default user-data-dir`,
      ),
      auto_repairable: input.defaultProfileDebugBlocks.length > 0,
    },
    {
      name: "local automation CDP",
      ok: localCdpReady,
      status: localCdpReady ? "ready" : "needs-action",
      detail: localCdpReady
        ? `Local CDP identity is verified on port ${String(input.directConnect.local_cdp.port)}.`
        : input.directConnect.local_cdp.reachable
          ? `Local CDP is reachable on port ${String(input.directConnect.local_cdp.port)}, but Uni-CLI cannot verify its profile identity.`
          : `Local CDP is not reachable on port ${String(input.directConnect.local_cdp.port)}.`,
      next_step: localCdpReady
        ? "No action."
        : "unicli browser doctor --repair",
      commands: localCdpReady
        ? ["unicli browser status"]
        : ["unicli browser doctor --repair", "unicli browser start"],
      auto_repairable: !localCdpReady,
    },
    {
      name: "daemon extension bridge",
      ok: input.backgroundOperation.status === "ready",
      status:
        input.backgroundOperation.status === "ready" ? "ready" : "needs-action",
      detail:
        input.backgroundOperation.status === "ready"
          ? "Daemon and extension are connected for background tab control."
          : `Daemon bridge is ${input.backgroundOperation.status}; local CDP can still serve command delivery if reachable.`,
      next_step:
        input.backgroundOperation.status === "ready"
          ? "No action."
          : "unicli daemon restart",
      commands: ["unicli daemon restart", "unicli browser bind"],
    },
    {
      name: "remote CDP",
      ok: remoteConfigured || hasDefaultBrowserPath,
      status:
        remoteConfigured || hasDefaultBrowserPath ? "ready" : "needs-action",
      detail: remoteConfigured
        ? "Remote CDP endpoint is configured."
        : hasDefaultBrowserPath
          ? "Remote CDP endpoint is optional; local browser delivery is already available."
          : "Remote CDP endpoint is optional but useful when no local browser path is reachable.",
      next_step: remoteConfigured
        ? "unicli browser remote --status"
        : hasDefaultBrowserPath
          ? "No action unless cloud browser is required."
          : "Set UNICLI_CDP_ENDPOINT or run `unicli browser doctor --repair` for local CDP.",
      commands: ["unicli browser remote --status"],
    },
  ];
}

function buildSelfRepair(input: {
  profiles: LocalBrowserProfile[];
  backgroundOperation: BrowserDoctorReport["background_operation"];
  directConnect: BrowserDoctorReport["direct_connect"];
  defaultProfileDebugBlocks: DefaultProfileDebugBlock[];
  remoteDebuggingPolicy: ChromeRemoteDebuggingPolicyReport;
}): BrowserDoctorReport["self_repair"] {
  const cdpReady = input.directConnect.local_cdp.identity_verified;
  const actions: BrowserSelfRepairAction[] = [];
  if (input.remoteDebuggingPolicy.state === "disabled") {
    actions.push({
      id: "enable-remote-debugging-policy",
      status: "manual",
      command: input.remoteDebuggingPolicy.next_step,
      safe: false,
      detail:
        "RemoteDebuggingAllowed=false is an admin policy boundary. Uni-CLI reports it and refuses unsupported bypasses.",
      expected_result:
        "chrome://policy no longer reports RemoteDebuggingAllowed=false; local CDP can then be repaired with `unicli browser doctor --repair`.",
    });
  }
  actions.push({
    id: "start-local-automation-cdp",
    status:
      input.remoteDebuggingPolicy.state === "disabled"
        ? "blocked"
        : cdpReady
          ? "not-needed"
          : "available",
    command: "unicli browser doctor --repair",
    safe: true,
    detail:
      input.remoteDebuggingPolicy.state === "disabled"
        ? "Blocked by Chrome policy RemoteDebuggingAllowed=false."
        : cdpReady
          ? "Local automation CDP already has verified profile identity."
          : "Starts Chrome with Uni-CLI's automation profile and --no-startup-window.",
    expected_result: `127.0.0.1:${String(input.directConnect.local_cdp.port)} listens from a ~/.unicli automation profile.`,
  });
  if (input.defaultProfileDebugBlocks.length > 0) {
    actions.push({
      id: "ignore-default-profile-debug-port",
      status: "manual",
      command:
        "Stop retrying the default-profile Chrome launch; run `unicli browser doctor --repair`.",
      safe: true,
      detail:
        "Chrome 136+ blocks remote debugging on default user-data-dir launches. Uni-CLI can repair the delivery path by starting an automation profile; it cannot make default-profile CDP supported.",
      expected_result:
        "Agent stops treating default-profile --remote-debugging-port with no listener as a transient race.",
    });
  }
  if (input.backgroundOperation.status !== "ready") {
    actions.push({
      id: "repair-daemon-extension-bridge",
      status: "manual",
      command: "unicli daemon restart && unicli browser bind",
      safe: false,
      detail:
        "Daemon/extension repair may need user-visible browser extension state, so doctor reports it but does not silently force it.",
      expected_result:
        "browser doctor reports background_operation=ready when extension connects.",
    });
  }
  if (input.profiles.length === 0) {
    actions.push({
      id: "create-local-profile-source",
      status: "manual",
      command:
        "Open Chrome/Arc/Brave/Edge once, sign in, then run `unicli browser profiles --json`.",
      safe: false,
      detail: "Profile creation and sign-in require user account intent.",
      expected_result: "browser doctor reports cookie_reuse=ready.",
    });
  }
  return {
    safe_command: "unicli browser doctor --repair",
    actions,
  };
}

function buildCompleteness(input: {
  cookieReuse: BrowserDoctorReport["cookie_reuse"];
  backgroundOperation: BrowserDoctorReport["background_operation"];
  browserUse: BrowserDoctorReport["browser_use"];
  directConnect: BrowserDoctorReport["direct_connect"];
  stabilityReliability: BrowserDoctorReport["stability_reliability"];
  repairRetry: BrowserDoctorReport["repair_retry"];
}): BrowserDoctorReport["completeness"] {
  const matrix: Record<BrowserCapabilityId, BrowserCapabilityCheck> = {
    cookie_reuse: capabilityCheck({
      status: input.cookieReuse.status === "ready" ? "ready" : "needs-action",
      evidence: [
        `profiles_count=${String(input.cookieReuse.profiles_count)}`,
        "raw_cookie_values_returned=false",
        "raw_cookie_export_supported=true",
        "direct_browser_cookie_import_supported=true",
        input.cookieReuse.direct_browser_cookie_import_command,
        input.cookieReuse.explicit_cookie_export_command,
      ],
      diagnostics:
        input.cookieReuse.status === "ready"
          ? []
          : ["no local Chromium-family profiles discovered"],
      repair_commands: [
        input.cookieReuse.command,
        input.cookieReuse.direct_browser_cookie_import_command,
        input.cookieReuse.explicit_cookie_export_command,
      ],
    }),
    background_operation: capabilityCheck({
      status:
        input.backgroundOperation.status === "ready" ? "ready" : "needs-action",
      evidence: [
        `daemon=${input.backgroundOperation.daemon.status}`,
        `extension_connected=${String(
          input.backgroundOperation.daemon.extension_connected,
        )}`,
        `sessions_count=${String(input.backgroundOperation.sessions_count)}`,
        "windowFocused=false by default",
        "doctor sessions probe is read-only",
      ],
      diagnostics: [
        input.backgroundOperation.daemon.conflict,
        input.backgroundOperation.daemon.error,
        input.backgroundOperation.session_error,
        input.backgroundOperation.status === "needs-extension"
          ? "browser daemon is running but extension is not connected"
          : undefined,
        input.backgroundOperation.status === "stopped"
          ? "browser daemon is not running"
          : undefined,
      ],
      repair_commands:
        input.backgroundOperation.status === "ready"
          ? ["unicli browser bind"]
          : ["unicli browser start", "unicli browser bind"],
    }),
    browser_use: capabilityCheck({
      status: "ready",
      evidence: input.browserUse.modes,
      repair_commands: ["unicli browser doctor --json"],
    }),
    page_layering: capabilityCheck({
      status: "ready",
      evidence: input.browserUse.layers.map((layer) => layer.name),
      repair_commands: ["unicli browser evidence --render-aware"],
    }),
    direct_connect: capabilityCheck({
      status:
        input.directConnect.local_cdp.identity_verified ||
        input.directConnect.remote_cdp.configured
          ? "ready"
          : "needs-action",
      evidence: [
        input.directConnect.local_cdp.identity_verified
          ? `local CDP identity verified on port ${String(
              input.directConnect.local_cdp.port,
            )}`
          : input.directConnect.local_cdp.reachable
            ? `local CDP reachable but identity unverified on port ${String(
                input.directConnect.local_cdp.port,
              )}`
            : `local CDP unreachable on port ${String(
                input.directConnect.local_cdp.port,
              )}`,
        input.directConnect.remote_cdp.configured
          ? "remote CDP configured"
          : "remote CDP not configured",
      ],
      diagnostics: [input.directConnect.local_cdp.error],
      repair_commands: [
        "unicli browser start",
        "unicli browser remote --status",
      ],
    }),
    stability: capabilityCheck({
      status: "ready",
      evidence: input.stabilityReliability.guards,
      repair_commands: ["unicli browser evidence --render-aware"],
    }),
    reliability: capabilityCheck({
      status:
        input.backgroundOperation.status === "ready" ||
        input.directConnect.local_cdp.reachable ||
        input.directConnect.remote_cdp.configured
          ? "ready"
          : "needs-action",
      evidence: [
        `background=${input.backgroundOperation.status}`,
        `local_cdp_reachable=${String(input.directConnect.local_cdp.reachable)}`,
        `remote_cdp_configured=${String(
          input.directConnect.remote_cdp.configured,
        )}`,
      ],
      diagnostics: [
        input.backgroundOperation.daemon.conflict,
        input.backgroundOperation.daemon.error,
        input.backgroundOperation.status === "stopped"
          ? "no browser control path is currently reachable"
          : undefined,
      ],
      repair_commands: [
        "unicli browser start",
        "unicli browser bind",
        "unicli browser remote --status",
      ],
    }),
    repair: capabilityCheck({
      status: "ready",
      evidence: input.repairRetry.recovery_commands,
      repair_commands: input.repairRetry.recovery_commands,
    }),
    retry: capabilityCheck({
      status: "ready",
      evidence: input.repairRetry.retry_policy.map(
        (policy) =>
          `${policy.surface} max_attempts=${String(policy.max_attempts)}`,
      ),
      repair_commands: ["unicli browser doctor --json"],
    }),
  };
  const missing = REQUIRED_BROWSER_CAPABILITIES.filter(
    (capability) => matrix[capability].status !== "ready",
  );
  return {
    complete: missing.length === 0,
    required_capabilities: [...REQUIRED_BROWSER_CAPABILITIES],
    missing,
    matrix,
  };
}

function capabilityCheck(input: {
  status: BrowserCapabilityStatus;
  evidence: string[];
  repair_commands: string[];
  diagnostics?: Array<string | undefined>;
}): BrowserCapabilityCheck {
  const diagnostics = (input.diagnostics ?? []).filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return {
    status: input.status,
    evidence: input.evidence,
    repair_commands: input.repair_commands,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function redactEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.protocol}//${parsed.host}${redactEndpointPath(parsed.pathname)}${parsed.search ? "?..." : ""}`;
  } catch {
    return endpoint
      .replace(/\/\/[^/@]+@/, "//")
      .replace(/(\/devtools\/(?:browser|page))\/[^?#]+/i, "$1/...")
      .replace(/\?.*$/, "?...")
      .replace(/#.*/, "");
  }
}

function redactEndpointPath(pathname: string): string {
  if (pathname === "" || pathname === "/") return "";
  const match = pathname.match(/^\/devtools\/(browser|page)(?:\/.*)?$/i);
  if (!match) return "/...";
  const base = `/devtools/${match[1].toLowerCase()}`;
  return pathname === base ? base : `${base}/...`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
