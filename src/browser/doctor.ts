/**
 * @owner       src/browser/doctor.ts
 * @does        Report Browser Runtime Broker, provider, Agent-session, target-lease, profile, visibility, TTL, policy, and exact repair truth.
 * @needs       src/browser runtime-launch/runtime-protocol/runtime-transport/launcher/local-profiles/profile-seed/chrome-policy/remote-browser
 * @feeds       src/commands/browser/index.ts, src/commands/status.ts, root doctor output
 * @breaks      Probe errors remain structured evidence; repair starts only the windowless broker control plane.
 * @invariants  Report-only mode never launches a broker or browser; repair never launches a browser provider; secrets and raw cookies are absent.
 * @side-effects Reads local browser/profile/policy/runtime files; explicit repair may start the detached broker service.
 * @perf        Local probes are synchronous except one bounded broker status IPC.
 * @concurrency Broker auto-start races converge through the exclusive broker lock.
 * @test        tests/unit/browser-doctor.test.ts, tests/unit/commands/browser.test.ts, tests/integration/browser-runtime-autostart.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { findChrome } from "./launcher.js";
import {
  detectDefaultProfileDebugBlocks,
  detectLocalBrowserProfiles,
  selectBrowserIdentityFromProfiles,
} from "./local-profiles.js";
import { detectChromeRemoteDebuggingPolicy } from "./chrome-policy.js";
import { isBrowserEphemeralRequested } from "./profile-seed.js";
import {
  ensureBrowserRuntimeBroker,
  probeBrowserRuntimeBroker,
} from "./runtime-launch.js";
import { CHROME_NATIVE_PROTOCOL_VERSION } from "./chrome-native-protocol.js";
import type { BrowserBrokerStatus } from "./runtime-protocol.js";
import { browserBrokerPaths } from "./runtime-transport.js";
import { readRemoteEndpoint } from "./remote-browser.js";

export type BrowserDoctorStatus = "ready" | "needs-action";

export interface BrowserDoctorCheck {
  id:
    | "broker_control_plane"
    | "managed_hidden"
    | "chrome_background"
    | "remote_hidden"
    | "profile_ownership"
    | "chrome_policy";
  status: "ready" | "available" | "needs-action" | "not-configured";
  evidence: Record<string, unknown>;
  next_step?: string;
}

export interface BrowserDoctorRepairAttempt {
  attempted: true;
  action: "broker.start";
  status: "started" | "already-running";
  broker_pid: number;
  runtime_id: string;
}

export interface BrowserDoctorReport {
  status: BrowserDoctorStatus;
  checked_at: string;
  default_path: {
    provider: "managed";
    visibility: "hidden";
    available: boolean;
    profile_source: "seeded" | "ephemeral" | "policy-blocked" | "unavailable";
  };
  broker: {
    state: "running" | "stopped" | "error";
    runtime_root: string;
    descriptor_path: string;
    runtime_id?: string;
    broker_pid?: number;
    uptime_ms?: number;
    session_ttl_ms?: number;
    error?: string;
  };
  providers:
    | BrowserBrokerStatus["providers"]
    | {
        managed: [];
        chrome: {
          connected: false;
          protocol_version: number;
          queued_commands: 0;
          in_flight_commands: 0;
          target_count: 0;
          stale_target_count: 0;
        };
        remote: {
          configured: boolean;
          endpoint_origin?: string;
          configuration_error?: string;
          target_count: 0;
          visibility: "hidden";
        };
      };
  sessions: BrowserBrokerStatus["sessions"];
  profiles: {
    count: number;
    selection_status: "selected" | "unavailable" | "ambiguous";
    preferred_profile_id?: string;
    ambiguous_profile_ids?: string[];
    browser_binary?: string;
    raw_cookie_values_returned: false;
  };
  chrome_remote_debugging: ReturnType<typeof detectChromeRemoteDebuggingPolicy>;
  default_profile_debug_blocks: ReturnType<
    typeof detectDefaultProfileDebugBlocks
  >;
  checks: BrowserDoctorCheck[];
  next_actions: string[];
  repair?: BrowserDoctorRepairAttempt;
}

export async function repairBrowserDoctor(): Promise<BrowserDoctorRepairAttempt> {
  const connection = await ensureBrowserRuntimeBroker();
  return {
    attempted: true,
    action: "broker.start",
    status: connection.spawned ? "started" : "already-running",
    broker_pid: connection.status.broker_pid,
    runtime_id: connection.status.runtime_id,
  };
}

export async function runBrowserDoctor(
  repair?: BrowserDoctorRepairAttempt,
): Promise<BrowserDoctorReport> {
  const checkedAt = new Date().toISOString();
  const paths = browserBrokerPaths();
  const brokerProbe = await readBrokerProbe();
  const profiles = detectLocalBrowserProfiles();
  const profileSelection = selectBrowserIdentityFromProfiles(profiles);
  const preferred =
    profileSelection.status === "selected"
      ? profileSelection.profile
      : undefined;
  const browserBinary = preferred?.browser_path_exists
    ? preferred.browser_path
    : (findChrome() ?? undefined);
  const ephemeral = isBrowserEphemeralRequested(process.env);
  const chromePolicy = detectChromeRemoteDebuggingPolicy();
  const managedProfileReady = Boolean(
    browserBinary && (preferred || ephemeral),
  );
  const managedAvailable =
    managedProfileReady && chromePolicy.state !== "disabled";
  const profileSource = !managedProfileReady
    ? "unavailable"
    : chromePolicy.state === "disabled"
      ? "policy-blocked"
      : ephemeral
        ? "ephemeral"
        : "seeded";
  const providers = brokerProbe.status?.providers ?? offlineProviders();
  const sessions = brokerProbe.status?.sessions ?? {
    sessions: [],
    tombstoned_session_ids: [],
    target_leases: [],
    pending_release_session_ids: [],
    pending_release_target_ids: [],
  };
  const debugBlocks = detectDefaultProfileDebugBlocks();
  const checks: BrowserDoctorCheck[] = [
    {
      id: "broker_control_plane",
      status: brokerProbe.state === "error" ? "needs-action" : "available",
      evidence: {
        state: brokerProbe.state,
        auto_start: true,
        ...(brokerProbe.error ? { error: brokerProbe.error } : {}),
      },
      ...(brokerProbe.state === "error"
        ? { next_step: "Run `unicli browser broker restart`." }
        : {}),
    },
    {
      id: "managed_hidden",
      status: managedAvailable ? "ready" : "needs-action",
      evidence: {
        visibility: "hidden",
        browser_binary: browserBinary ?? null,
        profile_source: profileSource,
        browser_process_started_by_doctor: false,
      },
      ...(managedAvailable
        ? {}
        : {
            next_step:
              chromePolicy.state === "disabled"
                ? chromePolicy.next_step
                : "Install Chrome and open/sign in once, or explicitly select `--ephemeral` for an empty profile.",
          }),
    },
    {
      id: "chrome_background",
      status: providers.chrome.connected ? "ready" : "needs-action",
      evidence: {
        visibility: "background",
        connected: providers.chrome.connected,
        target_count: providers.chrome.target_count,
      },
      ...(providers.chrome.connected
        ? {}
        : {
            next_step:
              "Install the native host, load the Uni-CLI extension, and keep an existing Chrome window open.",
          }),
    },
    {
      id: "remote_hidden",
      status: providers.remote.configuration_error
        ? "needs-action"
        : providers.remote.configured
          ? "ready"
          : "not-configured",
      evidence: providers.remote as unknown as Record<string, unknown>,
      ...(providers.remote.configuration_error
        ? {
            next_step:
              "Correct or unset UNICLI_CDP_ENDPOINT and UNICLI_CDP_HEADERS, then restart the broker.",
          }
        : providers.remote.configured
          ? {}
          : {
              next_step:
                "Set UNICLI_CDP_ENDPOINT only when remote CDP is required.",
            }),
    },
    {
      id: "profile_ownership",
      status: debugBlocks.length === 0 ? "ready" : "needs-action",
      evidence: {
        default_profile_cdp_block_count: debugBlocks.length,
        broker_uses_unicli_owned_profiles: true,
      },
      ...(debugBlocks.length === 0
        ? {}
        : {
            next_step:
              "Stop Chrome processes attempting CDP on a default user-data-dir; use broker-owned seeded profiles.",
          }),
    },
    {
      id: "chrome_policy",
      status: chromePolicy.state === "disabled" ? "needs-action" : "ready",
      evidence: chromePolicy as unknown as Record<string, unknown>,
      ...(chromePolicy.state === "disabled"
        ? { next_step: chromePolicy.next_step }
        : {}),
    },
  ];
  const nextActions = checks
    .filter((check) => check.status === "needs-action" && check.next_step)
    .map((check) => check.next_step!);
  return {
    status:
      managedAvailable && brokerProbe.state !== "error"
        ? "ready"
        : "needs-action",
    checked_at: checkedAt,
    default_path: {
      provider: "managed",
      visibility: "hidden",
      available: managedAvailable,
      profile_source: profileSource,
    },
    broker: {
      state: brokerProbe.state,
      runtime_root: paths.runtimeRoot,
      descriptor_path: paths.descriptorPath,
      ...(brokerProbe.status
        ? {
            runtime_id: brokerProbe.status.runtime_id,
            broker_pid: brokerProbe.status.broker_pid,
            uptime_ms: brokerProbe.status.uptime_ms,
            session_ttl_ms: brokerProbe.status.session_ttl_ms,
          }
        : {}),
      ...(brokerProbe.error ? { error: brokerProbe.error } : {}),
    },
    providers,
    sessions,
    profiles: {
      count: profiles.length,
      selection_status: profileSelection.status,
      ...(preferred ? { preferred_profile_id: preferred.id } : {}),
      ...(profileSelection.status === "ambiguous"
        ? { ambiguous_profile_ids: profileSelection.profile_ids }
        : {}),
      ...(browserBinary ? { browser_binary: browserBinary } : {}),
      raw_cookie_values_returned: false,
    },
    chrome_remote_debugging: chromePolicy,
    default_profile_debug_blocks: debugBlocks,
    checks,
    next_actions: nextActions,
    ...(repair ? { repair } : {}),
  };
}

async function readBrokerProbe(): Promise<{
  state: "running" | "stopped" | "error";
  status?: BrowserBrokerStatus;
  error?: string;
}> {
  try {
    const connection = await probeBrowserRuntimeBroker({
      requestTimeoutMs: 1_000,
    });
    return { state: "running", status: connection.status };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "browser_broker_unavailable") return { state: "stopped" };
    return { state: "error", error: errorMessage(error) };
  }
}

function offlineProviders(): BrowserDoctorReport["providers"] {
  let remote: ReturnType<typeof readRemoteEndpoint> = null;
  let configurationError: string | undefined;
  try {
    remote = readRemoteEndpoint();
  } catch (error) {
    configurationError = errorMessage(error);
  }
  return {
    managed: [],
    chrome: {
      connected: false,
      protocol_version: CHROME_NATIVE_PROTOCOL_VERSION,
      queued_commands: 0,
      in_flight_commands: 0,
      target_count: 0,
      stale_target_count: 0,
    },
    remote: {
      configured: remote !== null || configurationError !== undefined,
      ...(remote
        ? {
            endpoint_origin: `${new URL(remote.endpoint).protocol}//${new URL(remote.endpoint).host}`,
          }
        : {}),
      ...(configurationError
        ? { configuration_error: configurationError }
        : {}),
      target_count: 0,
      visibility: "hidden",
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
