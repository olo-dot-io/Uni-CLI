import { describe, expect, it } from "vitest";

import {
  formatDescribePayload,
  nearestDescribeNames,
  summarizeDescribePayload,
} from "../../../src/output/describe.js";
import type { AgentContext } from "../../../src/output/envelope.js";

const fullPayload = {
  command: "unicli demo search",
  description: "Search demo records",
  quarantined: false,
  strategy: "public",
  auth: false,
  auth_setup: "unicli auth setup demo",
  personalization: "library",
  browser: false,
  target_surface: "web",
  adapter_path: "src/adapters/demo/search.yaml",
  args_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "integer", description: "Result limit", default: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  example_stdin: { query: "example", limit: 10 },
  channels: {
    shell: "unicli demo search <query> [--limit <int>]",
    stdin: "echo '{...}' | unicli demo search",
  },
  next_actions: [
    {
      command: "unicli demo search --dry-run",
      description: "Preview the plan",
    },
  ],
  operation_policy: { effect: "read", approval_required: false },
  contract: {
    schema_version: "command-contract.v1",
    execution: {
      operator: "structured-api",
      interaction_impact: "background",
    },
    operation: { family: "search" },
    effect: { operation_effect: "read", idempotency: "guaranteed" },
    repair: { minimum_capability: "http.fetch" },
  },
};

const ctx: AgentContext = {
  command: "core.describe",
  duration_ms: 3,
  surface: "web",
};

describe("describe Agent UX", () => {
  it("keeps the invocation-complete contract and removes duplicated audit detail", () => {
    const summary = summarizeDescribePayload(fullPayload);

    expect(summary).toMatchObject({
      command: "unicli demo search",
      operator: "structured-api",
      operation_family: "search",
      effect: "read",
      idempotency: "guaranteed",
      interaction_impact: "background",
      minimum_capability: "http.fetch",
      auth_setup: "unicli auth setup demo",
      personalization: "library",
      args_schema: fullPayload.args_schema,
      channels: fullPayload.channels,
      contract_ref: {
        schema_version: "command-contract.v1",
        full_command: "unicli describe demo search --full",
      },
    });
    expect(summary).not.toHaveProperty("operation_policy");
    expect(summary).not.toHaveProperty("contract");
  });

  it("renders JSON, compact JSON, and Markdown from the same summary", () => {
    const summary = summarizeDescribePayload(fullPayload);
    const jsonEnvelope = JSON.parse(
      formatDescribePayload(summary, "json", ctx),
    );
    const compactEnvelope = JSON.parse(
      formatDescribePayload(summary, "compact", ctx),
    );
    const markdown = formatDescribePayload(summary, "md", ctx);

    expect(compactEnvelope).toEqual(jsonEnvelope);
    expect(jsonEnvelope.data.args_schema.required).toEqual(["query"]);
    for (const value of [
      "unicli demo search",
      "structured-api",
      "unicli auth setup demo",
      "library",
      "Search query",
      "unicli demo search <query> [--limit <int>]",
      "unicli demo search --dry-run",
    ]) {
      expect(markdown).toContain(value);
    }
  });

  it("ranks bounded typo recovery deterministically", () => {
    expect(
      nearestDescribeNames("hackernew", [
        "github",
        "hackernews",
        "hackernews-archive",
      ]),
    ).toEqual(["hackernews", "hackernews-archive"]);
    expect(nearestDescribeNames("topp", ["new", "top", "best"])).toEqual([
      "top",
    ]);
  });
});
