import { describe, expect, it } from "vitest";

import { buildCommandContract } from "../../src/core/command-contract.js";
import { lintCommandContract } from "../../src/core/command-contract-lint.js";
import * as core from "../../src/core/index.js";
import { describeCommand } from "../../src/commands/describe.js";
import {
  AdapterType,
  Strategy,
  type AdapterManifest,
} from "../../src/types.js";

describe("CommandContract", () => {
  it("projects registry metadata into one agent-native command contract", () => {
    const adapter: AdapterManifest = {
      name: "contract-fixture",
      displayName: "Contract Fixture",
      type: AdapterType.BROWSER,
      description: "Fixture adapter",
      version: "1.2.3",
      category: "testing",
      domain: "example.com",
      base: "https://example.com",
      strategy: Strategy.COOKIE,
      browser: true,
      commands: {
        capture: {
          name: "capture",
          description: "Capture a page",
          adapter_path: "src/adapters/contract-fixture/capture.yaml",
          target_surface: "web",
          minimum_capability: "cdp-browser.snapshot",
          adapterArgs: [
            {
              name: "url",
              type: "str",
              required: true,
              format: "uri",
              description: "Page URL",
            },
            { name: "limit", type: "int", default: 5 },
          ],
          columns: ["title", "url"],
          output: { type: "array", items: { title: "string", url: "string" } },
          paginated: true,
        },
      },
    };

    const contract = buildCommandContract({
      adapter,
      commandName: "capture",
      command: adapter.commands.capture,
    });

    expect(contract.identity).toMatchObject({
      site: "contract-fixture",
      command: "capture",
      display_name: "Contract Fixture capture",
      category: "testing",
      source_path: "src/adapters/contract-fixture/capture.yaml",
    });
    expect(contract.schemas.input.required).toEqual(["url"]);
    expect(contract.schemas.input.properties.url).toMatchObject({
      type: "string",
      format: "uri",
    });
    expect(contract.schemas.output).toMatchObject({
      type: "array",
      items: { title: "string", url: "string" },
    });
    expect(contract.effect).toMatchObject({
      safety_class: "auth_read",
      target_surface: "web",
      browser: true,
      read_only: true,
      open_world: true,
      paginated: true,
    });
    expect(contract.auth).toMatchObject({
      strategy: "cookie",
      required: true,
      setup_command: "unicli auth setup contract-fixture",
    });
    expect(contract.governance.resources.domains).toEqual(["example.com"]);
    expect(contract.eval).toMatchObject({
      fixture_status: "unknown",
      live_status: "unknown",
      health_status: "unknown",
    });
    expect(contract.repair).toMatchObject({
      adapter_path: "src/adapters/contract-fixture/capture.yaml",
      repair_command: "unicli repair contract-fixture capture",
      quarantined: false,
    });
    expect(contract.artifacts.validators).toEqual([]);
  });

  it("reports missing source path as a contract lint error", () => {
    const adapter: AdapterManifest = {
      name: "bad-contract",
      type: AdapterType.WEB_API,
      commands: {
        list: {
          name: "list",
          description: "List rows",
          adapterArgs: [],
        },
      },
    };

    const contract = buildCommandContract({
      adapter,
      commandName: "list",
      command: adapter.commands.list,
    });

    expect(lintCommandContract(contract)).toContainEqual({
      code: "missing_source_path",
      severity: "error",
      message: "bad-contract list has no adapter source path",
    });
  });

  it("makes describe payloads expose the same command contract", () => {
    const adapter: AdapterManifest = {
      name: "describe-contract",
      displayName: "Describe Contract",
      type: AdapterType.WEB_API,
      category: "testing",
      domain: "api.example.com",
      strategy: Strategy.PUBLIC,
      commands: {
        search: {
          name: "search",
          description: "Search records",
          adapter_path: "src/adapters/describe-contract/search.yaml",
          adapterArgs: [{ name: "query", type: "str", required: true }],
        },
      },
    };

    const payload = describeCommand(
      adapter.name,
      "search",
      adapter.commands.search,
      adapter,
    ) as { contract?: ReturnType<typeof buildCommandContract> };

    expect(payload.contract).toMatchObject({
      schema_version: "command-contract.v1",
      identity: {
        site: "describe-contract",
        command: "search",
        source_path: "src/adapters/describe-contract/search.yaml",
      },
      governance: {
        resources: {
          domains: ["api.example.com"],
        },
      },
      repair: {
        repair_command: "unicli repair describe-contract search",
      },
    });
  });

  it("exports the contract builders through the core barrel", () => {
    expect(typeof core.buildCommandContract).toBe("function");
    expect(typeof core.lintCommandContract).toBe("function");
  });
});
