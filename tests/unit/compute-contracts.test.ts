import { describe, expect, it } from "vitest";

import {
  buildComputeInputSchema,
  computeCommandCanMutate,
  getComputeCommandContract,
} from "../../src/compute/contracts.js";

describe("compute coordinate contracts", () => {
  it("keeps absolute point input separate from semantic element refs", () => {
    const contract = getComputeCommandContract("point-click");
    expect(contract?.executionOperator).toBe("visual-coordinate");
    const schema = buildComputeInputSchema(contract?.args ?? []);
    expect(schema.required).toEqual(["x", "y", "observation", "via"]);
    expect(schema.properties).not.toHaveProperty("ref");
    expect(schema.properties.observation).toMatchObject({
      type: "string",
      minLength: 83,
      maxLength: 83,
    });
    expect(schema.properties.via?.enum).toEqual(["driver", "visual"]);
  });

  it("treats screenshot file output as a mutation while inline capture is read-only", () => {
    expect(computeCommandCanMutate("compute_screenshot", {})).toBe(false);
    expect(
      computeCommandCanMutate("compute_screenshot", {
        path: "/tmp/frame.png",
      }),
    ).toBe(true);
  });

  it("keeps session reads read-only and lifecycle transitions mutating", () => {
    expect(computeCommandCanMutate("compute_session_state")).toBe(false);
    expect(computeCommandCanMutate("compute_session_start")).toBe(true);
    expect(computeCommandCanMutate("compute_session_escalate")).toBe(true);
    expect(computeCommandCanMutate("compute_session_end")).toBe(true);
  });

  it("models Cua session control as local protocol state rather than pixels", () => {
    expect(getComputeCommandContract("session-state")).toMatchObject({
      executionOperator: "local-runtime",
      executionProfile: {
        provider: "cua-driver",
        perception: "local-state",
        actuation: "none",
        target_scope: "local-runtime",
        verification: "local-result",
        interaction_impact: "background",
        coordinate_actuation: false,
      },
    });
    expect(getComputeCommandContract("session-start")).toMatchObject({
      executionOperator: "local-runtime",
      executionProfile: {
        provider: "cua-driver",
        perception: "local-state",
        actuation: "protocol-call",
        target_scope: "local-runtime",
        verification: "local-result",
        interaction_impact: "background",
        coordinate_actuation: false,
      },
    });
  });

  it("projects the complete portable pointer and keyboard parameters into MCP schemas", () => {
    const click = buildComputeInputSchema(
      getComputeCommandContract("point-click")?.args ?? [],
    );
    const drag = buildComputeInputSchema(
      getComputeCommandContract("drag")?.args ?? [],
    );
    const press = buildComputeInputSchema(
      getComputeCommandContract("press")?.args ?? [],
    );

    expect(click.properties.button?.enum).toEqual(["left", "right", "middle"]);
    expect(click.properties).toHaveProperty("count");
    expect(click.properties.count).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 3,
    });
    expect(drag.properties).toMatchObject({
      button: { enum: ["left", "right", "middle"] },
      durationMs: { type: "integer", minimum: 0, maximum: 10_000 },
      modifier: { type: "array", items: { type: "string" } },
      steps: { type: "integer", minimum: 1, maximum: 200 },
    });
    expect(press.properties.modifiers).toEqual({
      type: "array",
      items: { type: "string" },
      description:
        "Optional modifier keys for a single press_key. Encode a multi-key hotkey in combo instead.",
    });
  });

  it("keeps agent-cursor tools callable but presentation-scoped", () => {
    expect(getComputeCommandContract("agent-cursor-state")).toMatchObject({
      readOnly: true,
      executionOperator: "local-runtime",
      executionProfile: {
        provider: "cua-driver",
        perception: "local-state",
        actuation: "none",
        coordinate_actuation: false,
      },
    });
    for (const command of [
      "agent-cursor-enable",
      "agent-cursor-motion",
      "agent-cursor-theme",
    ]) {
      expect(getComputeCommandContract(command)).toMatchObject({
        executionOperator: "local-runtime",
        executionProfile: {
          provider: "cua-driver",
          actuation: "protocol-call",
          interaction_impact: "background",
          coordinate_actuation: false,
        },
      });
    }
    const motion = buildComputeInputSchema(
      getComputeCommandContract("agent-cursor-motion")?.args ?? [],
    );
    expect(motion.properties.spring?.type).toEqual(["number", "null"]);
    expect(motion.properties.turn_radius?.type).toEqual(["number", "null"]);
  });
});
