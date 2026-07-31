/**
 * @owner       src::engine::step-surface
 * @does        Derives, classifies, and budget-checks the executable built-in action surface from live registries.
 * @needs       registered step barrel/registry, visual/AX/UIA/AT-SPI handler tables, transport capability matrix
 * @feeds       static adapter lint, generated stats/docs, release truth tests
 * @breaks      Registry/matrix mismatch, duplicate ownership, or budget growth throws with exact action names.
 * @invariants  Built-ins split into registered pipeline actions and transport-native actions; plugins are excluded.
 * @side-effects Imports built-in step modules once so they self-register.
 * @perf        O(number of built-in actions), currently bounded at 113.
 * @concurrency Read-only after module initialization; registry initialization is module-scoped.
 * @test        tests/unit/step-surface.test.ts
 * @stability   stable
 * @since       2026-07-12
 */

import "./steps/index.js";
import { listSteps } from "./step-registry.js";
import { VISUAL_STEP_HANDLERS } from "./steps/visual.js";
import { DESKTOP_AX_STEP_HANDLERS } from "./steps/desktop-ax.js";
import { DESKTOP_SIDECAR_STEP_HANDLERS } from "./steps/desktop-sidecar.js";
import { CAPABILITY_MATRIX } from "../transport/capability.js";

export const REGISTERED_STEP_BUDGET = 58;
export const TRANSPORT_NATIVE_STEP_BUDGET = 55;

export interface BuiltInStepSurface {
  actions: readonly string[];
  registered: readonly string[];
  transportNative: readonly string[];
  totalCount: number;
  registeredCount: number;
  transportNativeCount: number;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return sorted([...left].filter((value) => !right.has(value)));
}

function assertNoMismatch(label: string, values: readonly string[]): void {
  if (values.length > 0) {
    throw new Error(`${label}: ${values.join(", ")}`);
  }
}

export function getBuiltInStepSurface(): BuiltInStepSurface {
  const registered = sorted(listSteps());
  const transportNative = sorted([
    ...Object.keys(VISUAL_STEP_HANDLERS),
    ...Object.keys(DESKTOP_AX_STEP_HANDLERS),
    ...Object.keys(DESKTOP_SIDECAR_STEP_HANDLERS),
  ]);
  const registeredSet = new Set(registered);
  const transportSet = new Set(transportNative);
  assertNoMismatch(
    "built-in action has both registered and transport-native owners",
    sorted([...registeredSet].filter((name) => transportSet.has(name))),
  );

  const actions = sorted([...registered, ...transportNative]);
  const actionSet = new Set(actions);
  const matrixSet = new Set(Object.keys(CAPABILITY_MATRIX));
  assertNoMismatch(
    "executable built-in actions missing capability rows",
    difference(actionSet, matrixSet),
  );
  assertNoMismatch(
    "capability rows without executable built-in owners",
    difference(matrixSet, actionSet),
  );

  if (registered.length > REGISTERED_STEP_BUDGET) {
    throw new Error(
      `registered pipeline action budget exceeded: ${registered.length}/${REGISTERED_STEP_BUDGET}; compose existing actions or use a plugin boundary`,
    );
  }
  if (transportNative.length > TRANSPORT_NATIVE_STEP_BUDGET) {
    throw new Error(
      `transport-native action budget exceeded: ${transportNative.length}/${TRANSPORT_NATIVE_STEP_BUDGET}; extend a transport operation before adding another action kind`,
    );
  }

  return {
    actions,
    registered,
    transportNative,
    totalCount: actions.length,
    registeredCount: registered.length,
    transportNativeCount: transportNative.length,
  };
}

export function builtInStepNames(): readonly string[] {
  return getBuiltInStepSurface().actions;
}
