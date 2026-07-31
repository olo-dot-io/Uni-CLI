/**
 * @owner       src::core::operator-model
 * @does        Project command execution metadata into one task-facing operator profile.
 * @needs       adapter type, target surface, browser flag, and declared capability tokens
 * @feeds       command contracts, discovery, route explanations, and architecture audits
 * @breaks      Misclassification can make an agent choose browser or visual control when a narrower structured operator exists.
 * @invariants  The declared minimum capability dominates broad adapter labels; visual and desktop operators are never inferred from target surface alone.
 * @side-effects None.
 * @perf        O(capability tokens) per uncached command projection.
 * @concurrency Pure and reentrant.
 * @test        tests/unit/operator-model.test.ts, tests/unit/command-contract.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

import { AdapterType } from "../types.js";
import type {
  ActuationModality,
  ExecutionOperator,
  OperatorTargetScope,
  PerceptionModality,
  TargetSurface,
} from "../types.js";

export interface CommandOperatorProfile {
  operator: ExecutionOperator;
  operator_source:
    | "declared"
    | "minimum_capability"
    | "capability"
    | "adapter_default";
  operator_confidence: "high" | "medium" | "low";
  provider: string;
  perception: PerceptionModality;
  actuation: ActuationModality;
  target_scope: OperatorTargetScope;
  verification:
    | "protocol-result"
    | "process-result"
    | "dom-state"
    | "accessibility-state"
    | "pixel-observation"
    | "local-result";
  interaction_impact: "background" | "target-scoped" | "foreground";
  coordinate_actuation: boolean;
  selection_reason: string;
}

export interface ResolveCommandOperatorInput {
  adapterType?: string;
  targetSurface: TargetSurface;
  browser: boolean;
  minimumCapability?: string;
  capabilities?: readonly string[];
  explicitOperator?: ExecutionOperator;
}

interface OperatorDefinition extends Omit<
  CommandOperatorProfile,
  "selection_reason" | "operator_source" | "operator_confidence"
> {}

const OPERATOR_DEFINITIONS: Readonly<
  Record<ExecutionOperator, OperatorDefinition>
> = {
  "structured-api": {
    operator: "structured-api",
    provider: "http-or-service-protocol",
    perception: "structured-data",
    actuation: "protocol-call",
    target_scope: "service",
    verification: "protocol-result",
    interaction_impact: "background",
    coordinate_actuation: false,
  },
  "browser-protocol": {
    operator: "browser-protocol",
    provider: "cdp-browser",
    perception: "structured-data",
    actuation: "protocol-call",
    target_scope: "browser-renderer",
    verification: "protocol-result",
    interaction_impact: "background",
    coordinate_actuation: false,
  },
  "native-cli": {
    operator: "native-cli",
    provider: "subprocess",
    perception: "process-output",
    actuation: "process-call",
    target_scope: "host-process",
    verification: "process-result",
    interaction_impact: "background",
    coordinate_actuation: false,
  },
  "browser-semantic": {
    operator: "browser-semantic",
    provider: "cdp-browser",
    perception: "dom-accessibility",
    actuation: "dom-action",
    target_scope: "browser-renderer",
    verification: "dom-state",
    interaction_impact: "background",
    coordinate_actuation: false,
  },
  "desktop-accessibility": {
    operator: "desktop-accessibility",
    provider: "platform-accessibility",
    perception: "os-accessibility",
    actuation: "accessibility-action",
    target_scope: "native-window",
    verification: "accessibility-state",
    interaction_impact: "target-scoped",
    coordinate_actuation: false,
  },
  "visual-observation": {
    operator: "visual-observation",
    provider: "screen-capture",
    perception: "pixels",
    actuation: "screen-capture",
    target_scope: "desktop",
    verification: "pixel-observation",
    interaction_impact: "background",
    coordinate_actuation: false,
  },
  "visual-coordinate": {
    operator: "visual-coordinate",
    provider: "explicit-coordinate-provider",
    perception: "pixels",
    actuation: "coordinate-action",
    target_scope: "desktop",
    verification: "pixel-observation",
    interaction_impact: "foreground",
    coordinate_actuation: true,
  },
  "local-runtime": {
    operator: "local-runtime",
    provider: "unicli-runtime",
    perception: "local-state",
    actuation: "local-function",
    target_scope: "local-runtime",
    verification: "local-result",
    interaction_impact: "background",
    coordinate_actuation: false,
  },
};

export function commandOperatorProfile(
  operator: ExecutionOperator,
  selectionReason: string,
  source: CommandOperatorProfile["operator_source"] = "declared",
  confidence: CommandOperatorProfile["operator_confidence"] = "high",
): CommandOperatorProfile {
  return {
    ...OPERATOR_DEFINITIONS[operator],
    operator_source: source,
    operator_confidence: confidence,
    selection_reason: selectionReason,
  };
}

export function resolveCommandOperator(
  input: ResolveCommandOperatorInput,
): CommandOperatorProfile {
  if (input.explicitOperator) {
    return commandOperatorProfile(
      input.explicitOperator,
      "declared by the command contract",
      "declared",
      "high",
    );
  }

  const minimum = input.minimumCapability?.toLowerCase();
  if (minimum) {
    const operator = operatorForCapability(minimum);
    if (operator) {
      return commandOperatorProfile(
        operator,
        `minimum capability ${input.minimumCapability}`,
        "minimum_capability",
        "high",
      );
    }
  }

  for (const capability of input.capabilities ?? []) {
    const operator = operatorForCapability(capability.toLowerCase());
    if (operator) {
      return commandOperatorProfile(
        operator,
        `declared capability ${capability}`,
        "capability",
        "medium",
      );
    }
  }

  if (input.browser || input.adapterType === AdapterType.BROWSER) {
    return commandOperatorProfile(
      "browser-semantic",
      "command requires a browser session",
      "adapter_default",
      "low",
    );
  }
  if (input.adapterType === AdapterType.BRIDGE) {
    return commandOperatorProfile(
      "native-cli",
      "bridge adapter invokes an external CLI",
      "adapter_default",
      "low",
    );
  }
  if (input.adapterType === AdapterType.DESKTOP) {
    return commandOperatorProfile(
      "native-cli",
      "desktop adapter invokes a local executable",
      "adapter_default",
      "low",
    );
  }
  if (
    input.adapterType === AdapterType.WEB_API ||
    input.adapterType === AdapterType.SERVICE ||
    input.targetSurface === "web"
  ) {
    return commandOperatorProfile(
      "structured-api",
      "command uses a structured service boundary",
      "adapter_default",
      "low",
    );
  }
  return commandOperatorProfile(
    "local-runtime",
    "command executes inside the Uni-CLI runtime",
    "adapter_default",
    "low",
  );
}

function operatorForCapability(
  capability: string,
): ExecutionOperator | undefined {
  if (capability.startsWith("visual.")) return "visual-coordinate";
  if (
    capability.startsWith("desktop-ax.") ||
    capability.startsWith("desktop-uia.") ||
    capability.startsWith("desktop-atspi.") ||
    capability.startsWith("compute.")
  ) {
    return "desktop-accessibility";
  }
  if (
    capability.startsWith("cdp-browser.") ||
    capability.startsWith("browser.")
  ) {
    return "browser-semantic";
  }
  if (capability.startsWith("subprocess.")) return "native-cli";
  if (
    capability.startsWith("http.") ||
    capability.startsWith("net.") ||
    capability.startsWith("service.")
  ) {
    return "structured-api";
  }
  return undefined;
}
