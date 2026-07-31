import { beforeAll, describe, expect, it } from "vitest";

import {
  evaluateCommandFeasibility,
  evaluateFeasibilityProfile,
  inferCapabilityRequirements,
  mergeCapabilityRequirements,
} from "../../src/discovery/feasibility.js";
import { loadAllAdapters, loadTsAdapters } from "../../src/discovery/loader.js";
import { search } from "../../src/discovery/search.js";

beforeAll(async () => {
  loadAllAdapters();
  await loadTsAdapters();
});

describe("command feasibility", () => {
  it("projects exact operator, target, effect, and interaction constraints", () => {
    const result = evaluateCommandFeasibility("hackernews", "top", {
      operator: "structured-api",
      target_surface: "web",
      target_scope: "service",
      effect: "read",
      max_interaction_impact: "background",
      allow_coordinate_actuation: false,
    });

    expect(result).toMatchObject({
      contract_compatible: true,
      evidence_scope: "catalog_contract",
      runtime_readiness: "not_evaluated",
      contract: {
        operator: "structured-api",
        operator_source: "minimum_capability",
        operator_confidence: "high",
        target_surface: "web",
        target_scope: "service",
        effect: "read",
        effect_source: expect.any(String),
        effect_confidence: expect.any(String),
        interaction_impact: "background",
        coordinate_actuation: false,
      },
      rejected_by: [],
    });
  });

  it("fails closed on an incompatible execution operator", () => {
    const result = evaluateCommandFeasibility("hackernews", "top", {
      operator: "browser-semantic",
    });

    expect(result.contract_compatible).toBe(false);
    expect(result.rejected_by).toEqual([
      "operator requires browser-semantic, candidate projects structured-api from minimum_capability",
    ]);
  });

  it("filters before top-k so every returned command satisfies the hard intersection", () => {
    const results = search("papers research", 12, {
      requirements: {
        operator: "structured-api",
        target_surface: "web",
        effect: "read",
        allow_coordinate_actuation: false,
      },
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(
        evaluateCommandFeasibility(result.site, result.command, {
          operator: "structured-api",
          target_surface: "web",
          effect: "read",
          allow_coordinate_actuation: false,
        }).contract_compatible,
      ).toBe(true);
    }
  });

  it("fails closed on explicit constraints even when projections are low-confidence", () => {
    const result = evaluateFeasibilityProfile(
      "unit",
      "heuristic",
      {
        operator: "structured-api",
        operator_source: "adapter_default",
        operator_confidence: "low",
        target_surface: "web",
        target_surface_source: "adapter_type",
        target_surface_confidence: "low",
        target_scope: "service",
        target_scope_source: "adapter_default",
        target_scope_confidence: "low",
        effect: "unknown_write",
        effect_source: "default",
        effect_confidence: "low",
        interaction_impact: "background",
        coordinate_actuation: false,
      },
      {
        operator: "native-cli",
        target_surface: "desktop",
        effect: "read",
      },
    );

    expect(result).toMatchObject({
      contract_compatible: false,
      compatibility: "incompatible",
    });
    expect(result.rejected_by).toHaveLength(3);
    expect(result.uncertain_by).toEqual([]);
  });

  it("infers only explicit substrate language and lets explicit constraints win", () => {
    expect(inferCapabilityRequirements("click this website")).toEqual({
      operation_family: "invoke",
    });
    expect(
      inferCapabilityRequirements("use a DOM ref through browser semantic"),
    ).toEqual({
      operator: "browser-semantic",
    });
    expect(
      inferCapabilityRequirements("click screen coordinate visually"),
    ).toEqual({
      operation_family: "invoke",
      operator: "visual-coordinate",
      allow_coordinate_actuation: true,
    });
    expect(
      inferCapabilityRequirements(
        "open desktop application using accessibility",
      ),
    ).toEqual({
      operation_family: "navigate",
      operator: "desktop-accessibility",
    });
    expect(
      inferCapabilityRequirements(
        "the article compares visual screenshots and coordinate systems",
      ),
    ).toEqual({});
    expect(
      mergeCapabilityRequirements(
        { operator: "browser-semantic" },
        { operator: "native-cli", platform: "darwin" },
      ),
    ).toEqual({ operator: "native-cli", platform: "darwin" });
  });
});
