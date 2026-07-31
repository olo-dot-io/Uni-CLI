/**
 * `unicli do <intent>` — plan-only natural-language router tests.
 *
 * Exercises the real BM25 search backend with the CORE_SEARCH_DOCUMENTS
 * corpus (always available, no manifest.json required), so no mocking of
 * owned modules (rule 03).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { Command } from "commander";
import { registerDoCommand } from "../../../src/commands/do.js";
import { validateEnvelope } from "../../../src/output/envelope.js";
import {
  loadAllAdapters,
  loadTsAdapters,
} from "../../../src/discovery/loader.js";
import { registerAdapter } from "../../../src/registry.js";
import { AdapterType } from "../../../src/types.js";

const deliveryFixtureHandler = vi.fn(async () => [
  { title: "delivery fixture result" },
]);

// Ensure the YAML adapter registry is populated so that `do` can enrich
// matches with args_schema / example_stdin via describeCommand.
beforeAll(async () => {
  loadAllAdapters();
  await loadTsAdapters();
  registerAdapter({
    name: "do-delivery-fixture",
    type: AdapterType.WEB_API,
    commands: {
      deliver: {
        name: "deliver",
        description:
          "Run the do delivery spec fixture for objective delivery planning",
        adapter_path: "src/adapters/do-delivery-fixture/deliver.ts",
        target_surface: "web",
        adapterArgs: [
          {
            name: "topic",
            type: "str",
            required: true,
            description: "Fixture topic",
          },
        ],
        func: deliveryFixtureHandler,
      },
    },
  });
});

function captureStdout(): {
  getStdout: () => string;
  getStderr: () => string;
  restore: () => void;
} {
  let out = "";
  let err = "";
  const origLog = console.log;
  const origError = console.error;
  console.log = ((...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    err += args.map(String).join(" ") + "\n";
  }) as typeof console.error;
  return {
    getStdout: () => out,
    getStderr: () => err,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

function newProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <fmt>", "output format");
  registerDoCommand(program);
  return program;
}

beforeEach(() => {
  process.exitCode = 0;
  deliveryFixtureHandler.mockClear();
});

afterEach(() => {
  process.exitCode = 0;
});

describe("unicli do — happy path", () => {
  it.each([
    ["read GitHub repository issues", "gh", "issue"],
    ["fetch a GitHub issue thread", "gh", "issue-thread"],
    ["read latest GitHub releases", "gh", "release"],
    ["get GitHub release", "gh", "release"],
    ["read https://x.com/jack/status/20", "twitter", "thread"],
    ["list HN top posts", "hackernews", "top"],
    ["read browser console using browser protocol", "browser", "console"],
    ["list open browser tabs using browser protocol", "browser", "tabs"],
    ["capture screenshot", "compute", "screenshot"],
  ])(
    "routes the compositional task frame %s",
    async (intent, site, command) => {
      const cap = captureStdout();
      try {
        const program = newProgram();
        await program.parseAsync([
          "node",
          "unicli",
          "do",
          ...intent.split(" "),
          "-f",
          "json",
        ]);
      } finally {
        cap.restore();
      }
      const env = JSON.parse(cap.getStdout());
      expect(env).toMatchObject({
        ok: true,
        data: { match: { site, command } },
      });
    },
  );

  it("returns a valid envelope for a recognizable intent", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "browser",
        "click",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("core.do");
    expect(env.data.intent).toBe("browser click");
    expect(env.data.match).not.toBeNull();
    expect(env.data.match.invocation).toBe("unicli browser click <ref>");
    expect(env.data.candidates[0].args_schema.required).toEqual(["ref"]);
    expect(env.data.candidates[0].example_stdin).toEqual({ ref: "<ref>" });
    expect(env.data.candidates.length).toBeGreaterThan(0);
  });

  it("intersects ranking with explicit capability requirements before top-k", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "papers",
        "research",
        "--operator",
        "structured-api",
        "--surface",
        "web",
        "--effect",
        "read",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    expect(env.ok).toBe(true);
    expect(env.data.routing_policy.requirements).toMatchObject({
      operator: "structured-api",
      target_surface: "web",
      effect: "read",
      allow_coordinate_actuation: false,
    });
    for (const candidate of env.data.candidates) {
      expect(candidate.operator.operator).toBe("structured-api");
      expect(candidate.feasibility).toMatchObject({
        contract_compatible: true,
        evidence_scope: "catalog_contract",
        runtime_readiness: "not_evaluated",
        rejected_by: [],
      });
    }
  });

  it("infers a hard operator only from explicit substrate language", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "browser",
        "semantic",
        "click",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    expect(env.ok).toBe(true);
    expect(env.data.routing_policy.requirements.operator).toBe(
      "browser-semantic",
    );
    for (const candidate of env.data.candidates) {
      expect(candidate.operator.operator).toBe("browser-semantic");
    }
  });

  it("includes args_schema by default and omits it under --no-schema", async () => {
    // with schema — query a YAML-backed adapter so describeCommand has args to surface
    let cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "huggingface",
        "papers",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const envWith = JSON.parse(cap.getStdout());
    const hasSchema = (
      envWith.data.candidates as Array<Record<string, unknown>>
    ).some((m) => "args_schema" in m);
    expect(hasSchema).toBe(true);

    // without schema
    cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "huggingface",
        "papers",
        "--no-schema",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const envSlim = JSON.parse(cap.getStdout());
    const hasSchemaSlim = (
      envSlim.data.candidates as Array<Record<string, unknown>>
    ).some((m) => "args_schema" in m);
    expect(hasSchemaSlim).toBe(false);
  });

  it("clamps --top to [1, 25] and respects requested top", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "browser",
        "--top",
        "2",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    expect((env.data.candidates as unknown[]).length).toBeLessThanOrEqual(2);
  });

  it("emits next_actions with direct invocation when no delivery template exists", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "browser",
        "click",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    const actions = env.next_actions as Array<{ command: string }>;
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions[0].command).toBe(env.data.match.invocation);
    const hasDescribe = actions.some((a) =>
      a.command.startsWith("unicli describe "),
    );
    expect(hasDescribe).toBe(true);
    expect(actions.some((action) => action.command.includes("echo '{}'"))).toBe(
      false,
    );
  });

  it("includes a delivery spec template for an executable top match without running it", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "do-delivery-fixture",
        "deliver",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(true);
    expect(env.data.match).toMatchObject({
      site: "do-delivery-fixture",
      command: "deliver",
      invocation: "unicli do-delivery-fixture deliver [--topic <str>]",
    });
    expect(env.data.delivery_spec_template).toMatchObject({
      objective: {
        id: "deliver-do-delivery-fixture-deliver",
        goal: "do-delivery-fixture deliver",
        evidence_gates: [
          { kind: "run_completed" },
          {
            kind: "required_evidence_type",
            evidence_type: "result-envelope",
          },
        ],
      },
      strategies: [
        {
          id: "adapter-do-delivery-fixture-deliver",
          kind: "adapter",
          command: "do-delivery-fixture.deliver",
          adapter_path: "src/adapters/do-delivery-fixture/deliver.ts",
          verify_command: "unicli test do-delivery-fixture deliver",
        },
      ],
      attempts: [],
      runs: [],
    });
    const actions = env.next_actions as Array<{ command: string }>;
    expect(actions[0].command).toBe("unicli delivery run <delivery-spec.json>");
    expect(actions[1].command).toBe(env.data.match.invocation);
    expect(deliveryFixtureHandler).not.toHaveBeenCalled();
  });

  it("prefers an objective plan over command BM25 when the user asks to play a song", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "我想听",
        "I really wanna stay at your house",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(true);
    expect(env.data.match).toBeNull();
    expect(env.data.objective_plan).toMatchObject({
      schema_version: "objective-plan.v1",
      objective: {
        id: "media-playback",
        kind: "media.playback",
        slots: {
          query: "I really wanna stay at your house",
        },
      },
      delivery_spec_template: {
        strategies: [
          {
            id: "spotify-api-play-track",
            command: "spotify.play-track",
            args: {
              query: "I really wanna stay at your house",
            },
            verify_command: "unicli spotify status",
          },
        ],
      },
    });
    expect(env.data.delivery_spec_template).toMatchObject({
      objective: {
        id: "media-playback",
        evidence_gates: [
          { kind: "run_completed" },
          { kind: "required_evidence_type", evidence_type: "result-envelope" },
        ],
      },
      strategies: [
        {
          id: "spotify-api-play-track",
          kind: "adapter",
          command: "spotify.play-track",
        },
      ],
    });
    expect(env.data.catalog_candidates[0]).not.toMatchObject({
      site: "ctrip",
      command: "hotel-search",
    });
    const actions = env.next_actions as Array<{ command: string }>;
    expect(actions[0].command).toBe(
      "unicli delivery run <objective-delivery-spec.json>",
    );
    expect(actions[1].command).toBe("unicli spotify play-track");
  });
});

describe("unicli do — empty path", () => {
  it("emits route_unavailable when hard constraints block semantic matches", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "search",
        "Linux.do",
        "using",
        "direct",
        "HTTP",
        "without",
        "browser",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    expect(cap.getStdout()).toBe("");
    const env = JSON.parse(cap.getStderr());
    validateEnvelope(env);
    expect(env).toMatchObject({
      ok: false,
      error: {
        code: "route_unavailable",
        retryable: false,
        details: {
          requirements: {
            required_sites: ["linux-do"],
            operation_family: "search",
            operator: "structured-api",
            allow_browser: false,
          },
          blocked_candidates: expect.any(Array),
        },
      },
    });
    expect(process.exitCode).toBe(66);
  });

  it("emits empty_result envelope on a no-signal query", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "qqqqqqzzzzzzthisisnotacommand",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStderr());
    expect(cap.getStdout()).toBe("");
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("empty_result");
    expect(env.error.retryable).toBe(false);
    expect(process.exitCode).toBe(66);
    // next_actions should suggest broadening
    const acts = env.next_actions as Array<{ command: string }>;
    expect(acts.some((a) => a.command.startsWith("unicli search"))).toBe(true);
  });
});

describe("unicli do — invalid input", () => {
  it("emits invalid_input envelope when --top is non-numeric", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "huggingface",
        "papers",
        "--top",
        "abc",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStderr());
    expect(cap.getStdout()).toBe("");
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("invalid_input");
    expect(env.error.message).toMatch(/--top/);
    expect(process.exitCode).toBe(2);
  });

  it("emits invalid_input envelope when --top exceeds hard limit", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "huggingface",
        "papers",
        "--top",
        "999",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStderr());
    expect(cap.getStdout()).toBe("");
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("invalid_input");
    expect(env.error.message).toMatch(/exceeds hard limit/);
    expect(process.exitCode).toBe(2);
  });
});
