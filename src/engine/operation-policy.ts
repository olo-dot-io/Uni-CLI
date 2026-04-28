/**
 * User-selectable operation policy.
 *
 * Adapter metadata stays open by default. This layer classifies likely side
 * effects from the command contract and lets users opt into stricter approval
 * profiles without forcing every adapter author to pre-label privacy.
 */

import { AdapterType, type TargetSurface } from "../types.js";
import {
  buildCapabilityApprovalMemory,
  deriveCapabilityScope,
} from "./capability-policy.js";
import type {
  CapabilityApprovalMemory,
  CapabilityScope,
} from "./capability-policy.js";

export type PermissionProfile = "open" | "confirm" | "locked";
export type OperationRisk = "none" | "low" | "medium" | "high";
export type OperationEffect =
  | "read"
  | "send_message"
  | "publish_content"
  | "account_state"
  | "remote_transform"
  | "remote_resource"
  | "service_state"
  | "local_app"
  | "local_file"
  | "destructive"
  | "unknown_write";

export interface OperationPolicyInput {
  site: string;
  command: string;
  description?: string;
  adapterType?: string;
  targetSurface?: TargetSurface;
  strategy?: string;
  domain?: string;
  base?: string;
  browser?: boolean;
  args?: Array<{ name: string; required?: boolean }>;
  profile?: string;
  approved?: boolean;
  approvalSource?: "none" | "invocation" | "env" | "memory";
}

export interface OperationPolicy {
  profile: PermissionProfile;
  effect: OperationEffect;
  risk: OperationRisk;
  capability_scope: CapabilityScope;
  approval_memory: CapabilityApprovalMemory;
  approval_required: boolean;
  approved: boolean;
  enforcement: "allow" | "needs_approval" | "deny";
  reason: string;
  approval_hint?: string;
  deny_rule?: {
    id: string;
    reason: string;
  };
  deny_reason?: string;
}

export class InvalidPermissionProfileError extends Error {
  constructor(profile: string) {
    super(
      `invalid permission profile "${profile}"; expected one of: open, confirm, locked`,
    );
    this.name = "InvalidPermissionProfileError";
  }
}

const OPEN_PROFILES = new Set<PermissionProfile>(["open", "confirm", "locked"]);

const MESSAGE_TOKENS = new Set([
  "ask",
  "dm",
  "greet",
  "mail-send",
  "messages-send",
  "reply",
  "reply-dm",
  "send",
]);

const PUBLISH_TOKENS = new Set([
  "comment",
  "create-draft",
  "draft",
  "post",
  "publish",
  "reel",
  "repost",
  "story",
  "tweet",
]);

const ACCOUNT_STATE_TOKENS = new Set([
  "accept",
  "add-friend",
  "block",
  "bookmark",
  "coin",
  "follow",
  "hide-reply",
  "like",
  "list-add",
  "list-remove",
  "mute",
  "pin",
  "rate",
  "save",
  "subscribe",
  "unblock",
  "unbookmark",
  "unfollow",
  "unlike",
  "unmute",
  "unsave",
  "upvote",
  "vote",
]);

const DESTRUCTIVE_EXACT_COMMANDS = new Set([
  "delete",
  "delete-stub",
  "destroy",
  "empty-trash",
  "rm",
  "reset",
  "trash",
]);

const DESTRUCTIVE_PIECES = new Set(["delete", "destroy", "reset", "trash"]);

const REMOTE_TRANSFORM_TOKENS = new Set([
  "background",
  "face-swap",
  "object-remover",
  "remove-bg",
  "restore",
  "try-on",
  "upscale",
]);

const SERVICE_STATE_TOKENS = new Set([
  "add",
  "create",
  "create-stub",
  "set",
  "update",
]);

const REMOTE_RESOURCE_TOKENS = new Set([
  "copy",
  "create",
  "issue-create",
  "mkdir",
  "move",
  "mv",
  "rename",
]);

const REMOTE_WEB_STRATEGIES = new Set([
  "public",
  "cookie",
  "header",
  "intercept",
  "ui",
]);

const LOCAL_APP_TOKENS = new Set([
  "calendar-create",
  "click-text",
  "do-not-disturb",
  "lock-screen",
  "model",
  "new",
  "notify",
  "open",
  "open-app",
  "press",
  "reminder-create",
  "reminders-complete",
  "screen-lock",
  "shortcuts-run",
  "sleep",
  "type-text",
  "wallpaper",
]);

const LOCAL_FILE_TOKENS = new Set([
  "clipboard",
  "convert",
  "export",
  "extract-audio",
  "finder-copy",
  "finder-move",
  "finder-new-folder",
  "gif",
  "import",
  "normalize",
  "print",
  "resize",
  "render",
  "screen-recording",
  "screenshot",
  "thumbnail",
  "trim",
  "upload",
]);

const CONTENT_ARG_NAMES = new Set([
  "body",
  "content",
  "message",
  "notes",
  "prompt",
  "subject",
  "text",
  "title",
  "draft",
]);

function commandTokens(site: string, command: string): Set<string> {
  const raw = `${site}-${command}`.toLowerCase();
  const pieces = raw.split(/[^a-z0-9]+/).filter(Boolean);
  return new Set([raw, command.toLowerCase(), ...pieces]);
}

function hasAny(tokens: Set<string>, candidates: Set<string>): boolean {
  for (const candidate of candidates) {
    if (tokens.has(candidate)) return true;
  }
  return false;
}

function hasContentArg(args: OperationPolicyInput["args"] = []): boolean {
  return args.some((arg) => CONTENT_ARG_NAMES.has(arg.name.toLowerCase()));
}

function normalizedDescription(input: OperationPolicyInput): string {
  return (input.description ?? "").trim().toLowerCase();
}

function looksReadOnlyCommand(input: OperationPolicyInput): boolean {
  const description = normalizedDescription(input);
  if (!/^(dump|fetch|get|inspect|list|read|search|show)\b/.test(description)) {
    return false;
  }
  return !hasContentArg(input.args);
}

function isExplicitLocalSurface(surface?: TargetSurface): boolean {
  return surface === "desktop" || surface === "system";
}

function isRemoteWebSurface(input: OperationPolicyInput): boolean {
  if (
    input.adapterType === AdapterType.BRIDGE ||
    input.adapterType === AdapterType.DESKTOP ||
    input.adapterType === AdapterType.SERVICE ||
    isExplicitLocalSurface(input.targetSurface)
  ) {
    return false;
  }
  return (
    (input.targetSurface === undefined && input.adapterType === undefined) ||
    input.targetSurface === "web" ||
    input.targetSurface === "mobile" ||
    input.adapterType === AdapterType.WEB_API ||
    input.adapterType === AdapterType.BROWSER ||
    input.browser === true ||
    (input.strategy !== undefined && REMOTE_WEB_STRATEGIES.has(input.strategy))
  );
}

function hasDestructiveIntent(
  input: OperationPolicyInput,
  tokens: Set<string>,
): boolean {
  const command = input.command.toLowerCase();
  const description = normalizedDescription(input);
  return (
    DESTRUCTIVE_EXACT_COMMANDS.has(command) ||
    hasAny(tokens, DESTRUCTIVE_EXACT_COMMANDS) ||
    hasAny(tokens, DESTRUCTIVE_PIECES) ||
    /^(delete|remove|clear)\b/.test(description)
  );
}

function looksMessageCommand(
  input: OperationPolicyInput,
  tokens: Set<string>,
): boolean {
  const description = normalizedDescription(input);
  return (
    (hasAny(tokens, MESSAGE_TOKENS) && hasContentArg(input.args)) ||
    /^(send|greet|batch greet)\b/.test(description)
  );
}

function looksPublishCommand(
  input: OperationPolicyInput,
  tokens: Set<string>,
): boolean {
  const description = normalizedDescription(input);
  return (
    (hasAny(tokens, PUBLISH_TOKENS) && hasContentArg(input.args)) ||
    /^(post|publish|repost)\b/.test(description) ||
    /^create\b.*\b(post|article draft|draft)\b/.test(description) ||
    /^upload\b.*\bdraft\b/.test(description) ||
    /^submit\b.*\bvenue\b/.test(description)
  );
}

function looksRemoteTransformCommand(
  input: OperationPolicyInput,
  tokens: Set<string>,
): boolean {
  const description = normalizedDescription(input);
  return (
    isRemoteWebSurface(input) &&
    (hasAny(tokens, REMOTE_TRANSFORM_TOKENS) ||
      /^generate\b.*\bimage\b/.test(description) ||
      /^submit\b.*\b(ai review|feedback)\b/.test(description))
  );
}

function looksServiceStateMutation(
  input: OperationPolicyInput,
  tokens: Set<string>,
): boolean {
  const description = normalizedDescription(input);
  return (
    input.adapterType === AdapterType.SERVICE &&
    (hasDestructiveIntent(input, tokens) ||
      hasAny(tokens, SERVICE_STATE_TOKENS) ||
      /^(add|create|set|update)\b/.test(description))
  );
}

function looksRemoteResourceCommand(
  input: OperationPolicyInput,
  tokens: Set<string>,
): boolean {
  const description = normalizedDescription(input);
  return (
    isRemoteWebSurface(input) &&
    (hasAny(tokens, REMOTE_RESOURCE_TOKENS) ||
      /^(copy|create|move|rename|save|submit)\b/.test(description))
  );
}

function isTargetSurface(value: unknown): value is TargetSurface {
  return (
    value === "web" ||
    value === "desktop" ||
    value === "system" ||
    value === "mobile"
  );
}

export function resolvePermissionProfile(value?: string): PermissionProfile {
  const configured = value ?? process.env.UNICLI_PERMISSION_PROFILE;
  if (configured === undefined || configured.trim() === "") return "open";

  const raw = configured.trim().toLowerCase();
  if (OPEN_PROFILES.has(raw as PermissionProfile)) {
    return raw as PermissionProfile;
  }
  throw new InvalidPermissionProfileError(configured);
}

export function resolveOperationTargetSurface(input: {
  adapterType?: string;
  targetSurface?: TargetSurface;
}): TargetSurface {
  if (isTargetSurface(input.targetSurface)) return input.targetSurface;
  switch (input.adapterType) {
    case AdapterType.DESKTOP:
      return "desktop";
    case AdapterType.BRIDGE:
    case AdapterType.SERVICE:
      return "system";
    default:
      return "web";
  }
}

export function resolveOperationAdapterPath(
  site: string,
  command: string,
  adapterPath?: string,
): string {
  return adapterPath ?? `src/adapters/${site}/${command}.yaml`;
}

export function inferOperationEffect(
  input: OperationPolicyInput,
): OperationEffect {
  const tokens = commandTokens(input.site, input.command);

  if (looksReadOnlyCommand(input)) return "read";
  if (hasAny(tokens, ACCOUNT_STATE_TOKENS)) return "account_state";
  if (looksMessageCommand(input, tokens)) return "send_message";
  if (looksPublishCommand(input, tokens)) return "publish_content";
  if (looksRemoteTransformCommand(input, tokens)) return "remote_transform";
  if (looksServiceStateMutation(input, tokens)) return "service_state";
  if (hasDestructiveIntent(input, tokens)) return "destructive";
  if (looksRemoteResourceCommand(input, tokens)) return "remote_resource";
  if (hasAny(tokens, LOCAL_APP_TOKENS)) return "local_app";
  if (
    input.adapterType === AdapterType.DESKTOP ||
    hasAny(tokens, LOCAL_FILE_TOKENS)
  ) {
    return "local_file";
  }
  return "read";
}

export function riskForEffect(effect: OperationEffect): OperationRisk {
  switch (effect) {
    case "read":
      return "low";
    case "account_state":
    case "remote_transform":
    case "remote_resource":
    case "local_app":
    case "local_file":
    case "unknown_write":
      return "medium";
    case "destructive":
    case "service_state":
    case "publish_content":
    case "send_message":
      return "high";
    default:
      return "none";
  }
}

function approvalRequired(
  profile: PermissionProfile,
  risk: OperationRisk,
): boolean {
  if (profile === "open") return false;
  if (profile === "confirm") return risk === "high";
  return risk === "medium" || risk === "high";
}

export function evaluateOperationPolicy(
  input: OperationPolicyInput,
): OperationPolicy {
  const profile = resolvePermissionProfile(input.profile);
  const effect = inferOperationEffect(input);
  const risk = riskForEffect(effect);
  const envApproved = process.env.UNICLI_APPROVE === "1";
  const approvalSource =
    input.approvalSource ??
    (input.approved === true ? "invocation" : envApproved ? "env" : "none");
  const approved =
    input.approved === true || envApproved || approvalSource === "memory";
  const approval_required = approvalRequired(profile, risk);
  const enforcement =
    approval_required && !approved ? "needs_approval" : "allow";
  const capability_scope = deriveCapabilityScope(input, effect);
  const approval_memory = buildCapabilityApprovalMemory({
    site: input.site,
    command: input.command,
    profile,
    effect,
    approved,
    approvalSource,
    scope: capability_scope,
  });
  const reason =
    effect === "read"
      ? "classified as read-only by command contract"
      : `classified as ${effect.replaceAll("_", " ")} with ${risk} risk`;

  return {
    profile,
    effect,
    risk,
    capability_scope,
    approval_memory,
    approval_required,
    approved,
    enforcement,
    reason,
    ...(enforcement === "needs_approval"
      ? {
          approval_hint:
            "rerun with --yes, add --remember-approval to persist this command scope, set UNICLI_APPROVE=1, or use --permission-profile open",
        }
      : {}),
  };
}
