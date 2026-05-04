import type { SidecarError } from "../sidecar.js";

type SemanticRule = {
  readonly key: string;
  readonly pattern: RegExp;
};

const UIA_RULES: readonly SemanticRule[] = [
  { key: "no_element", pattern: /no element|not found|stale ref/i },
  {
    key: "not_invokable",
    pattern: /not invokable|invoke pattern|does not expose.*invoke/i,
  },
  { key: "timeout", pattern: /timed? out|timeout/i },
  { key: "permission", pattern: /access denied|permission|uiaccess|elevated/i },
];

const ATSPI_RULES: readonly SemanticRule[] = [
  { key: "no_element", pattern: /no element|not found|stale ref/i },
  { key: "dbus_blocked", pattern: /d-?bus|bus daemon/i },
  {
    key: "no_a11y_attr",
    pattern: /no accessibility|accessibility attributes|no a11y|a11y attr/i,
  },
  { key: "wayland-input", pattern: /wayland/i },
  { key: "x11-input", pattern: /\bx11\b|xdotool/i },
];

export function normalizeDesktopSidecarError(
  transport: "desktop-uia" | "desktop-atspi",
  error: SidecarError,
): SidecarError {
  if (
    error.exit_code !== 69 ||
    !error.minimum_capability.startsWith(`${transport}.`)
  ) {
    return error;
  }
  const rules = transport === "desktop-uia" ? UIA_RULES : ATSPI_RULES;
  const semanticKey = rules.find((rule) => rule.pattern.test(error.reason));
  if (!semanticKey) return error;
  return {
    ...error,
    minimum_capability: `${transport}.${semanticKey.key}`,
  };
}
