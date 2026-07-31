/**
 * @owner       src::transport::adapters::cua-driver
 * @does        Adapt the portable Cua Driver desktop contract into Uni-CLI's explicitly selected coordinate/session transport.
 * @needs       Cua Driver CLI contract 0.2.0, contained process ownership, effect verdicts, transport envelopes.
 * @feeds       explicit compute driver routes and provider conformance probes.
 * @breaks      Schema drift, an unavailable daemon, or cancellation after a mutating daemon call can leave the desktop outcome unknown.
 * @invariants  This adapter never starts a daemon, changes route, targets an app/window, or retries a mutation; every physical call is desktop-scoped and uses argv rather than a shell.
 * @side-effects Invokes an optional local cua-driver daemon through its one-shot CLI and may capture or mutate the foreground desktop.
 * @perf        One contained CLI process per call; provider latency dominates.
 * @concurrency Each call owns one child process; daemon session identity is caller-supplied and never stored globally.
 * @test        tests/unit/transport/adapters/cua-driver.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

import {
  attachDefaultEffectVerdict,
  confirmedEffectVerdict,
  pendingEffectVerdict,
  suspectedNoopEffectVerdict,
} from "../../core/effect-verdict.js";
import { err, exitCodeFor, ok, type Envelope } from "../../core/envelope.js";
import { settleDispatchedAction } from "../action-settlement.js";
import {
  CUA_DRIVER_LOGICAL_ACTIONS,
  CUA_DRIVER_READ_ONLY_ACTIONS,
  CURSOR_MOTION_FIELDS,
  decodeCuaPng,
  validateCuaDriverOutput,
} from "./cua-driver-contract.js";
import {
  isOperationOutcomeAmbiguousError,
  runContainedProcess,
  type ContainedProcessResult,
} from "../contained-process.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  SnapshotRequest,
  TransportAdapter,
  TransportContext,
  TransportKind,
} from "../types.js";

export const CUA_DRIVER_CONTRACT_VERSION = "0.2.0";

export const CUA_DRIVER_STEPS = CUA_DRIVER_LOGICAL_ACTIONS;

const CUA_DRIVER_CAPABILITY: Capability = {
  steps: CUA_DRIVER_STEPS,
  snapshotFormats: ["screenshot"],
  mutatesHost: true,
};

const ESCALATION_REASONS = new Set([
  "ax_tree_pixel_mismatch",
  "background_delivery_failed",
  "foreground_ineffective",
  "no_window_target",
  "other",
]);

export interface CuaDriverInvocation {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  canMutate: boolean;
}

export type CuaDriverRunner = (
  invocation: CuaDriverInvocation,
) => Promise<ContainedProcessResult>;

export interface CuaDriverTransportOptions {
  command?: string;
  argsPrefix?: readonly string[];
  env?: NodeJS.ProcessEnv;
  runner?: CuaDriverRunner;
}

interface CuaCall {
  tool: string;
  args: Record<string, unknown>;
}

type CuaCallPreparation =
  | { ok: true; value: CuaCall }
  | { ok: false; result: ActionResult<never> };

export class CuaDriverTransport implements TransportAdapter {
  readonly kind: TransportKind = "cua-driver";
  readonly capability: Capability = CUA_DRIVER_CAPABILITY;

  private readonly command: string;
  private readonly argsPrefix: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: CuaDriverRunner;
  private readonly configurationError: string | undefined;
  private ctx: TransportContext | undefined;

  constructor(options: CuaDriverTransportOptions = {}) {
    this.env = options.env ?? process.env;
    this.command =
      options.command ??
      this.env.UNICLI_CUA_DRIVER_COMMAND?.trim() ??
      "cua-driver";
    const parsedArgs = parseArgsPrefix(this.env.UNICLI_CUA_DRIVER_ARGS);
    this.argsPrefix =
      options.argsPrefix ?? (parsedArgs.ok ? parsedArgs.value : []);
    this.configurationError =
      options.argsPrefix === undefined && !parsedArgs.ok
        ? parsedArgs.reason
        : undefined;
    this.runner = options.runner ?? runCuaDriverProcess;
  }

  async open(ctx: TransportContext): Promise<void> {
    ctx.signal?.throwIfAborted();
    this.ctx = ctx;
  }

  async snapshot(opts: SnapshotRequest = {}): Promise<Snapshot> {
    const result = await this.action<Record<string, unknown>>({
      kind: "cua_get_desktop_state",
      params: { ...opts.params },
      signal: opts.signal,
      canMutate: false,
    });
    if (!result.ok) {
      throw new CuaDriverTransportError(result.error);
    }
    const png = decodeCuaPng(result.data.screenshot_png_b64);
    if (!png) {
      throw new Error(
        "cua-driver get_desktop_state returned invalid PNG bytes",
      );
    }
    return {
      format: "screenshot",
      data: png,
      ...(finiteNumber(result.data.screenshot_width) !== undefined
        ? { width: finiteNumber(result.data.screenshot_width) }
        : {}),
      ...(finiteNumber(result.data.screenshot_height) !== undefined
        ? { height: finiteNumber(result.data.screenshot_height) }
        : {}),
    };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    const startedAt = Date.now();
    const canMutate = cuaActionCanMutate(req) || req.canMutate === true;
    if (this.configurationError) {
      return attachDefaultEffectVerdict(
        err({
          transport: "cua-driver",
          step: 0,
          action: req.kind,
          reason: this.configurationError,
          suggestion:
            "set UNICLI_CUA_DRIVER_ARGS to a JSON array of literal argv entries",
          minimum_capability: "cua-driver.configuration",
          retryable: false,
          exit_code: exitCodeFor("config_error"),
        }) as ActionResult<T>,
        {
          canMutate,
          phase: "pre_dispatch",
          verification: "cua-driver-contract",
        },
      );
    }
    const prepared = prepareCuaCall(req);
    if (!prepared.ok) {
      prepared.result.elapsedMs = Date.now() - startedAt;
      return attachDefaultEffectVerdict(prepared.result as ActionResult<T>, {
        canMutate,
        phase: "pre_dispatch",
        verification: "cua-driver-contract",
      });
    }

    try {
      const result = await settleDispatchedAction(
        req.kind,
        canMutate,
        req.signal,
        () => this.invoke<T>(prepared.value, req, canMutate),
      );
      result.elapsedMs = Date.now() - startedAt;
      return result;
    } catch (error) {
      if (isOperationOutcomeAmbiguousError(error)) throw error;
      req.signal?.throwIfAborted();
      const missing = isMissingExecutable(error);
      return attachDefaultEffectVerdict(
        err({
          transport: "cua-driver",
          step: 0,
          action: req.kind,
          reason: missing
            ? `Cua Driver executable ${JSON.stringify(this.command)} is unavailable`
            : `Cua Driver call failed before a result was received: ${errorMessage(error)}`,
          suggestion: missing
            ? "install Cua Driver or set UNICLI_CUA_DRIVER_COMMAND, then run `unicli doctor compute --providers --json`"
            : "inspect `cua-driver status` and the daemon logs",
          minimum_capability: `cua-driver.${req.kind}`,
          retryable: false,
          exit_code: exitCodeFor(
            missing ? "config_error" : "service_unavailable",
          ),
        }) as ActionResult<T>,
        {
          canMutate,
          phase: missing ? "pre_dispatch" : "dispatched_failure",
          verification: "cua-driver-contract",
        },
      );
    }
  }

  async close(): Promise<void> {
    this.ctx = undefined;
  }

  private async invoke<T>(
    call: CuaCall,
    req: ActionRequest,
    canMutate: boolean,
  ): Promise<ActionResult<T>> {
    const result = await this.runner({
      command: this.command,
      args: [...this.argsPrefix, "call", call.tool, JSON.stringify(call.args)],
      ...(this.ctx?.cwd ? { cwd: this.ctx.cwd } : {}),
      env: this.env,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      canMutate,
    });
    if (result.exitCode !== 0) {
      const detail = bounded(
        result.stderr.trim() || result.stdout.trim() || "no diagnostic output",
      );
      return err({
        transport: "cua-driver",
        step: 0,
        action: req.kind,
        reason: `cua-driver ${call.tool} exited ${String(result.exitCode)}: ${detail}`,
        suggestion:
          "inspect `cua-driver status`, repair the reported permission or daemon boundary, and retry only after checking target state for mutations",
        minimum_capability: `cua-driver.${call.tool}`,
        retryable: !canMutate && result.exitCode === 75,
        exit_code:
          result.exitCode > 0 && result.exitCode <= 255
            ? result.exitCode
            : exitCodeFor("service_unavailable"),
      });
    }

    const parsed = parseStructuredOutput(result.stdout);
    if (!parsed.ok) {
      return err({
        transport: "cua-driver",
        step: 0,
        action: req.kind,
        reason: parsed.reason,
        suggestion:
          "upgrade Cua Driver to a release implementing portable contract 0.2.0 and rerun the provider doctor",
        minimum_capability: `cua-driver.contract.${CUA_DRIVER_CONTRACT_VERSION}`,
        retryable: false,
        exit_code: exitCodeFor("config_error"),
      });
    }
    const validation = validateCuaDriverOutput(
      call.tool,
      call.args,
      parsed.value,
    );
    if (validation.status === "refused") {
      const refusal = err({
        transport: "cua-driver",
        step: 0,
        action: req.kind,
        reason: `Cua Driver refused ${call.tool}: ${validation.reason}`,
        suggestion:
          "satisfy the refusal's declared facility or permission requirement; do not switch providers implicitly",
        minimum_capability: `cua-driver.${call.tool}.refused`,
        retryable: false,
        exit_code: exitCodeFor("permission_denied"),
      });
      if (canMutate) {
        refusal.effect_verdict = suspectedNoopEffectVerdict(
          "Cua Driver returned a structured refusal without dispatching the requested external effect",
          "cua-driver refusal",
          "provider_refusal",
        );
      }
      return refusal;
    }
    if (validation.status === "invalid") {
      return err({
        transport: "cua-driver",
        step: 0,
        action: req.kind,
        reason: validation.reason,
        suggestion:
          "upgrade Cua Driver to a compatible portable-contract release and rerun the provider doctor",
        minimum_capability: `cua-driver.contract.${CUA_DRIVER_CONTRACT_VERSION}`,
        retryable: false,
        exit_code: exitCodeFor("config_error"),
      });
    }

    const envelope = ok({
      provider: "cua-driver",
      minimum_contract_version: CUA_DRIVER_CONTRACT_VERSION,
      tool: call.tool,
      ...validation.value,
    } as T);
    if (canMutate && validation.effect === "postcondition") {
      envelope.effect_verdict = confirmedEffectVerdict(
        "postcondition_observation",
        "Cua Driver reported a confirmed postcondition for the completed desktop action",
        "cua-driver effect",
      );
    } else if (canMutate && validation.effect === "authoritative") {
      envelope.effect_verdict = confirmedEffectVerdict(
        "authoritative_response",
        "Cua Driver returned the authoritative session state produced by the lifecycle operation",
        "cua-driver session state",
      );
    } else if (canMutate && validation.effect === "suspected-noop") {
      envelope.effect_verdict = suspectedNoopEffectVerdict(
        "Cua Driver reported that the desktop action almost certainly did not change its target",
        "cua-driver effect",
        "provider_noop_signal",
      );
    } else if (canMutate && validation.effect === "pending") {
      envelope.effect_verdict = pendingEffectVerdict(
        "Cua Driver accepted the action but deferred effect confirmation; take a fresh observation before considering any retry",
        "cua-driver deferred observation",
      );
    }
    return envelope;
  }
}

export class CuaDriverTransportError extends Error {
  readonly suggestion: string;
  readonly minimum_capability?: string;
  readonly retryable?: boolean;
  readonly exit_code?: number;

  constructor(
    readonly envelope: Extract<Envelope<never>, { ok: false }>["error"],
  ) {
    super(envelope.reason);
    this.name = "CuaDriverTransportError";
    this.suggestion = envelope.suggestion;
    this.minimum_capability = envelope.minimum_capability;
    this.retryable = envelope.retryable;
    this.exit_code = envelope.exit_code;
  }
}

async function runCuaDriverProcess(
  invocation: CuaDriverInvocation,
): Promise<ContainedProcessResult> {
  return runContainedProcess(invocation.command, invocation.args, {
    ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
    ...(invocation.env ? { env: invocation.env } : {}),
    ...(invocation.timeoutMs === undefined
      ? {}
      : { timeoutMs: invocation.timeoutMs }),
    ...(invocation.signal ? { signal: invocation.signal } : {}),
    cancellationDelivery: invocation.canMutate
      ? "outcome-ambiguous"
      : "contained",
  });
}

function prepareCuaCall(req: ActionRequest): CuaCallPreparation {
  const sessionResult = optionalString(req.params.session, "session");
  if (!sessionResult.ok) return invalid(req, sessionResult.reason);
  const withSession = (
    args: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...args,
    ...(sessionResult.value ? { session: sessionResult.value } : {}),
  });

  switch (req.kind) {
    case "cua_click": {
      const point = pointFrom(req.params, "x", "y");
      if (!point.ok) return invalid(req, point.reason);
      const button =
        req.params.button === undefined ? "left" : req.params.button;
      if (button !== "left" && button !== "right" && button !== "middle") {
        return invalid(req, "button must be left, right, or middle");
      }
      const count = boundedInteger(req.params.count, "count", 1, 3, 1);
      if (!count.ok) return invalid(req, count.reason);
      return {
        ok: true,
        value: {
          tool: "click",
          args: withSession({
            ...point.value,
            button,
            count: count.value,
            scope: "desktop",
          }),
        },
      };
    }
    case "cua_drag": {
      const from = pointFrom(req.params, "fromX", "fromY");
      const to = pointFrom(req.params, "toX", "toY");
      if (!from.ok) return invalid(req, from.reason);
      if (!to.ok) return invalid(req, to.reason);
      const button = req.params.button ?? "left";
      if (button !== "left" && button !== "right" && button !== "middle") {
        return invalid(req, "button must be left, right, or middle");
      }
      const duration = boundedInteger(
        req.params.durationMs,
        "durationMs",
        0,
        10_000,
      );
      if (!duration.ok) return invalid(req, duration.reason);
      const steps = boundedInteger(req.params.steps, "steps", 1, 200);
      if (!steps.ok) return invalid(req, steps.reason);
      const modifier = optionalStringArray(req.params.modifier, "modifier");
      if (!modifier.ok) return invalid(req, modifier.reason);
      return {
        ok: true,
        value: {
          tool: "drag",
          args: withSession({
            from_x: from.value.x,
            from_y: from.value.y,
            to_x: to.value.x,
            to_y: to.value.y,
            button,
            ...(duration.value === undefined
              ? {}
              : { duration_ms: duration.value }),
            ...(modifier.value === undefined
              ? {}
              : { modifier: modifier.value }),
            ...(steps.value === undefined ? {} : { steps: steps.value }),
            scope: "desktop",
          }),
        },
      };
    }
    case "cua_type_text": {
      if (typeof req.params.text !== "string") {
        return invalid(req, "text must be a string");
      }
      return {
        ok: true,
        value: {
          tool: "type_text",
          args: withSession({
            text: req.params.text,
            scope: "desktop",
          }),
        },
      };
    }
    case "cua_press": {
      const combo =
        typeof req.params.combo === "string"
          ? req.params.combo
          : typeof req.params.key === "string"
            ? req.params.key
            : undefined;
      const keys = combo
        ?.split("+")
        .map((key) => key.trim())
        .filter(Boolean);
      if (!keys || keys.length === 0) {
        return invalid(req, "combo or key must contain at least one key");
      }
      const modifiers = optionalStringArray(req.params.modifiers, "modifiers");
      if (!modifiers.ok) return invalid(req, modifiers.reason);
      if (keys.length > 1 && modifiers.value !== undefined) {
        return invalid(
          req,
          "modifiers is available only for a single press_key; encode hotkeys in combo",
        );
      }
      return keys.length === 1
        ? {
            ok: true,
            value: {
              tool: "press_key",
              args: withSession({
                key: keys[0],
                ...(modifiers.value === undefined
                  ? {}
                  : { modifiers: modifiers.value }),
                scope: "desktop",
              }),
            },
          }
        : {
            ok: true,
            value: {
              tool: "hotkey",
              args: withSession({ keys, scope: "desktop" }),
            },
          };
    }
    case "cua_scroll": {
      const point = pointFrom(req.params, "x", "y");
      if (!point.ok) return invalid(req, point.reason);
      const direction = req.params.direction ?? "down";
      if (
        direction !== "up" &&
        direction !== "down" &&
        direction !== "left" &&
        direction !== "right"
      ) {
        return invalid(req, "direction must be up, down, left, or right");
      }
      const amount = req.params.amount ?? 3;
      if (
        typeof amount !== "number" ||
        !Number.isSafeInteger(amount) ||
        amount < 1 ||
        amount > 50
      ) {
        return invalid(req, "amount must be an integer from 1 to 50");
      }
      const by = req.params.by ?? "line";
      if (by !== "line" && by !== "page") {
        return invalid(req, "by must be line or page");
      }
      return {
        ok: true,
        value: {
          tool: "scroll",
          args: withSession({
            ...point.value,
            direction,
            amount,
            by,
            scope: "desktop",
          }),
        },
      };
    }
    case "cua_get_desktop_state": {
      const path =
        req.params.path === undefined
          ? undefined
          : optionalString(req.params.path, "path");
      if (path && !path.ok) return invalid(req, path.reason);
      return {
        ok: true,
        value: {
          tool: "get_desktop_state",
          args: withSession(
            path?.value ? { screenshot_out_file: path.value } : {},
          ),
        },
      };
    }
    case "cua_get_screen_size":
    case "cua_get_cursor_position": {
      return {
        ok: true,
        value: {
          tool:
            req.kind === "cua_get_screen_size"
              ? "get_screen_size"
              : "get_cursor_position",
          args: withSession({}),
        },
      };
    }
    case "cua_move_cursor": {
      const point = pointFrom(req.params, "x", "y");
      if (!point.ok) return invalid(req, point.reason);
      return {
        ok: true,
        value: {
          tool: "move_cursor",
          args: withSession({ ...point.value, scope: "desktop" }),
        },
      };
    }
    case "cua_start_session": {
      if (!sessionResult.value) {
        return invalid(req, "session must be a non-empty string");
      }
      const captureScope = req.params.captureScope ?? "auto";
      if (
        captureScope !== "auto" &&
        captureScope !== "window" &&
        captureScope !== "desktop"
      ) {
        return invalid(req, "captureScope must be auto, window, or desktop");
      }
      const cursorThemeId = optionalString(
        req.params.cursorThemeId,
        "cursorThemeId",
      );
      if (!cursorThemeId.ok) return invalid(req, cursorThemeId.reason);
      const reducedMotion = req.params.reducedMotion ?? "auto";
      if (
        reducedMotion !== "auto" &&
        reducedMotion !== "on" &&
        reducedMotion !== "off"
      ) {
        return invalid(req, "reducedMotion must be auto, on, or off");
      }
      return {
        ok: true,
        value: {
          tool: "start_session",
          args: {
            session: sessionResult.value,
            capture_scope: captureScope,
            ...(cursorThemeId.value
              ? {
                  cursor_theme: {
                    theme_id: cursorThemeId.value,
                    reduced_motion: reducedMotion,
                  },
                }
              : {}),
          },
        },
      };
    }
    case "cua_get_session_state":
    case "cua_end_session": {
      if (!sessionResult.value) {
        return invalid(req, "session must be a non-empty string");
      }
      return {
        ok: true,
        value: {
          tool:
            req.kind === "cua_get_session_state"
              ? "get_session_state"
              : "end_session",
          args: { session: sessionResult.value },
        },
      };
    }
    case "cua_escalate_session": {
      if (!sessionResult.value) {
        return invalid(req, "session must be a non-empty string");
      }
      const reason = req.params.reason;
      if (typeof reason !== "string" || !ESCALATION_REASONS.has(reason)) {
        return invalid(
          req,
          "reason must be ax_tree_pixel_mismatch, background_delivery_failed, foreground_ineffective, no_window_target, or other",
        );
      }
      const detailResult = optionalString(req.params.detail, "detail");
      if (!detailResult.ok) return invalid(req, detailResult.reason);
      if (detailResult.value && detailResult.value.length > 200) {
        return invalid(req, "detail must not exceed 200 characters");
      }
      return {
        ok: true,
        value: {
          tool: "escalate_session",
          args: {
            session: sessionResult.value,
            reason,
            ...(detailResult.value ? { detail: detailResult.value } : {}),
          },
        },
      };
    }
    case "cua_get_agent_cursor_state": {
      if (!sessionResult.value) {
        return invalid(req, "session must be a non-empty string");
      }
      return {
        ok: true,
        value: {
          tool: "get_agent_cursor_state",
          args: { session: sessionResult.value },
        },
      };
    }
    case "cua_set_agent_cursor_enabled": {
      if (!sessionResult.value) {
        return invalid(req, "session must be a non-empty string");
      }
      if (typeof req.params.enabled !== "boolean") {
        return invalid(req, "enabled must be a boolean");
      }
      return {
        ok: true,
        value: {
          tool: "set_agent_cursor_enabled",
          args: {
            session: sessionResult.value,
            enabled: req.params.enabled,
          },
        },
      };
    }
    case "cua_set_agent_cursor_motion": {
      if (!sessionResult.value) {
        return invalid(req, "session must be a non-empty string");
      }
      const args: Record<string, unknown> = {
        session: sessionResult.value,
      };
      for (const field of CURSOR_MOTION_FIELDS) {
        const value = req.params[field];
        if (
          value !== undefined &&
          value !== null &&
          finiteNumber(value) === undefined
        ) {
          return invalid(req, `${field} must be a finite number or null`);
        }
        if (value !== undefined) args[field] = value;
      }
      return {
        ok: true,
        value: { tool: "set_agent_cursor_motion", args },
      };
    }
    case "cua_set_agent_cursor_theme": {
      if (!sessionResult.value) {
        return invalid(req, "session must be a non-empty string");
      }
      const themeId = optionalString(req.params.themeId, "themeId");
      if (!themeId.ok) return invalid(req, themeId.reason);
      if (!themeId.value || themeId.value.length > 200) {
        return invalid(
          req,
          "themeId must be a non-empty string of at most 200 characters",
        );
      }
      const reducedMotion = req.params.reducedMotion ?? "auto";
      if (
        reducedMotion !== "auto" &&
        reducedMotion !== "on" &&
        reducedMotion !== "off"
      ) {
        return invalid(req, "reducedMotion must be auto, on, or off");
      }
      return {
        ok: true,
        value: {
          tool: "set_agent_cursor_theme",
          args: {
            session: sessionResult.value,
            theme_id: themeId.value,
            reduced_motion: reducedMotion,
          },
        },
      };
    }
    default:
      return invalid(
        req,
        `unsupported action ${JSON.stringify(req.kind)}; supported actions: ${CUA_DRIVER_STEPS.join(", ")}`,
      );
  }
}

function invalid(req: ActionRequest, reason: string): CuaCallPreparation {
  return {
    ok: false,
    result: err({
      transport: "cua-driver",
      step: 0,
      action: req.kind,
      reason,
      suggestion:
        "use the explicit coordinate/session command schema shown by `unicli describe compute <command>`",
      minimum_capability: `cua-driver.${req.kind}.valid_input`,
      retryable: false,
      exit_code: exitCodeFor("usage_error"),
    }),
  };
}

function pointFrom(
  params: Record<string, unknown>,
  xKey: string,
  yKey: string,
):
  | { ok: true; value: { x: number; y: number } }
  | { ok: false; reason: string } {
  const x = finiteNumber(params[xKey]);
  const y = finiteNumber(params[yKey]);
  return x === undefined || y === undefined
    ? { ok: false, reason: `${xKey} and ${yKey} must be finite numbers` }
    : { ok: true, value: { x, y } };
}

function optionalString(
  value: unknown,
  name: string,
): { ok: true; value?: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, reason: `${name} must be a non-empty string` };
  }
  return { ok: true, value: value.trim() };
}

function optionalStringArray(
  value: unknown,
  name: string,
): { ok: true; value?: string[] } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    return {
      ok: false,
      reason: `${name} must be an array of non-empty strings`,
    };
  }
  return { ok: true, value: value.map((item) => item.trim()) };
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  defaultValue?: number,
): { ok: true; value?: number } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: defaultValue };
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? { ok: true, value }
    : {
        ok: false,
        reason: `${name} must be an integer from ${minimum} to ${maximum}`,
      };
}

function parseStructuredOutput(
  stdout: string,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string } {
  const value = stdout.trim();
  if (!value) {
    return {
      ok: false,
      reason: "cua-driver returned exit 0 without structured output",
    };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed)
      ? { ok: true, value: parsed }
      : {
          ok: false,
          reason: "cua-driver structured output must be a JSON object",
        };
  } catch (error) {
    return {
      ok: false,
      reason: `cua-driver output is not valid JSON: ${errorMessage(error)}`,
    };
  }
}

function parseArgsPrefix(
  value: string | undefined,
): { ok: true; value: readonly string[] } | { ok: false; reason: string } {
  if (!value?.trim()) return { ok: true, value: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return { ok: true, value: parsed };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `UNICLI_CUA_DRIVER_ARGS is invalid JSON: ${errorMessage(error)}`,
    };
  }
  return {
    ok: false,
    reason: "UNICLI_CUA_DRIVER_ARGS must be a JSON array of strings",
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function cuaActionCanMutate(req: ActionRequest): boolean {
  if (
    req.kind === "cua_get_desktop_state" &&
    typeof req.params.path === "string" &&
    req.params.path.trim().length > 0
  ) {
    return true;
  }
  return !CUA_DRIVER_READ_ONLY_ACTIONS.has(req.kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingExecutable(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === "ENOENT" ||
      (error.cause !== undefined && isMissingExecutable(error.cause)))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: string, max = 2_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
