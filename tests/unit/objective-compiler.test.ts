import { beforeAll, describe, expect, it } from "vitest";

import { loadAllAdapters, loadTsAdapters } from "../../src/discovery/loader.js";
import { compileObjectivePlan } from "../../src/engine/objective/index.js";

beforeAll(async () => {
  loadAllAdapters();
  await loadTsAdapters();
});

describe("objective compiler", () => {
  it("compiles listen-to-song intents into a media playback objective", () => {
    const plan = compileObjectivePlan(
      "我想听 I really wanna stay at your house",
    );

    expect(plan).toMatchObject({
      schema_version: "objective-plan.v1",
      objective: {
        id: "media-playback",
        kind: "media.playback",
        goal: "我想听 I really wanna stay at your house",
        slots: {
          query: "I really wanna stay at your house",
        },
      },
    });
    expect(plan?.strategies[0]).toMatchObject({
      id: "spotify-api-play-track",
      substrate: "native-api",
      provider: "spotify",
      status: "executable",
      verification: {
        command: "spotify.status",
      },
    });
    expect(plan?.delivery_spec_template).toMatchObject({
      objective: {
        id: "media-playback",
        evidence_gates: [
          { kind: "run_completed" },
          { kind: "required_evidence_type", evidence_type: "result-envelope" },
        ],
        attempt_budget: {
          max_attempts_per_strategy: 1,
        },
      },
      strategies: [
        {
          id: "spotify-api-play-track",
          kind: "adapter",
          command: "spotify.play-track",
          args: {
            query: "I really wanna stay at your house",
          },
          verify_command: "unicli spotify status",
        },
      ],
      attempts: [],
      runs: [],
    });
    expect(
      plan?.strategies.some((strategy) => strategy.provider === "apple-music"),
    ).toBe(true);
  });

  it("demotes strategies whose command refs are not registered", () => {
    const plan = compileObjectivePlan(
      "我想听 I really wanna stay at your house",
      {
        hasCommand(command: string): boolean {
          return command !== "spotify.play-track";
        },
      },
    );

    expect(plan?.strategies[0]).toMatchObject({
      provider: "spotify",
      status: "missing",
    });
    expect(plan?.delivery_spec_template).toBeUndefined();
    expect(plan?.capability_gaps).toContainEqual(
      expect.objectContaining({
        provider: "spotify",
        missing: "spotify.play-track",
      }),
    );
  });

  it("does not classify unrelated travel stay intents as media playback", () => {
    const plan = compileObjectivePlan(
      "search Ctrip hotels for a weekend stay in Shanghai",
    );

    expect(plan).toBeUndefined();
  });
});
