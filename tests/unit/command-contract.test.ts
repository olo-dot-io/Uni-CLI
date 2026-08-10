import { describe, expect, it } from "vitest";

import {
  buildCommandContract,
  buildCoreCommandContract,
  buildManifestCommandContract,
} from "../../src/core/command-contract.js";
import { lintCommandContract } from "../../src/core/command-contract-lint.js";
import * as core from "../../src/core/index.js";
import {
  describe as describeUnicli,
  describeCommand,
} from "../../src/commands/describe.js";
import {
  getCoreDiscoveryCommand,
  listCoreDiscoveryCommands,
} from "../../src/discovery/core-catalog.js";
import {
  AdapterType,
  Strategy,
  type AdapterManifest,
} from "../../src/types.js";

describe("CommandContract", () => {
  it("declares the effect of every scholarly core command", () => {
    const scholarly = listCoreDiscoveryCommands().filter(
      (command) => command.site === "scholar",
    );
    expect(scholarly.length).toBeGreaterThan(0);
    expect(
      scholarly.every((command) => command.operation_effect !== undefined),
    ).toBe(true);
    expect(
      scholarly.every((command) => command.operation_family !== "unknown"),
    ).toBe(true);
    expect(getCoreDiscoveryCommand("scholar", "search")?.operation_effect).toBe(
      "read",
    );
    expect(
      getCoreDiscoveryCommand("scholar", "download")?.operation_effect,
    ).toBe("download_file");
  });

  it("treats a CDP minimum capability as browser use even on a web-api registration helper", () => {
    const adapter: AdapterManifest = {
      name: "electron-helper",
      type: AdapterType.WEB_API,
      strategy: Strategy.PUBLIC,
      commands: {
        read: {
          name: "read",
          target_surface: "desktop",
          browser: false,
          minimum_capability: "cdp-browser.cdp_attach",
        },
      },
    };

    const contract = buildCommandContract({
      adapter,
      commandName: "read",
      command: adapter.commands.read,
    });

    expect(contract.execution).toMatchObject({
      operator: "browser-semantic",
      target_scope: "browser-renderer",
    });
    expect(contract.effect.browser).toBe(true);
    expect(contract.governance.dimensions.browser.access).not.toBe("none");
  });

  it("preserves command-specific session operator edges in core discovery", () => {
    const state = getCoreDiscoveryCommand("compute", "session-state");
    const start = getCoreDiscoveryCommand("compute", "session-start");

    expect(
      state && buildCoreCommandContract({ command: state }).execution,
    ).toMatchObject({
      operator: "local-runtime",
      provider: "cua-driver",
      perception: "local-state",
      actuation: "none",
      target_scope: "local-runtime",
      verification: "local-result",
      interaction_impact: "background",
      coordinate_actuation: false,
    });
    expect(
      start && buildCoreCommandContract({ command: start }).execution,
    ).toMatchObject({
      operator: "local-runtime",
      provider: "cua-driver",
      actuation: "protocol-call",
      coordinate_actuation: false,
    });
  });

  it("treats browser clicks as non-idempotent writes", () => {
    for (const site of ["browser", "operate"]) {
      const command = getCoreDiscoveryCommand(site, "click");
      expect(
        command && buildCoreCommandContract({ command }).effect,
      ).toMatchObject({
        operation_effect: "unknown_write",
        read_only: false,
        idempotent: false,
      });
    }
  });

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
          operation_effect: "read",
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
      effect_source: "declared",
      effect_confidence: "high",
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

  it("uses the generated effect decision instead of reclassifying an incomplete read model", () => {
    const contract = buildManifestCommandContract({
      site: "manifest-fixture",
      commandName: "search",
      adapterType: "web-api",
      command: {
        description: "Search while submitting a stateful upstream query",
        strategy: "public",
        operation_family: "search",
        effect_projection: {
          operation_effect: "unknown_write",
          effect_source: "default",
          effect_confidence: "low",
        },
      },
    });

    expect(contract.effect).toMatchObject({
      operation_effect: "unknown_write",
      effect_source: "default",
      effect_confidence: "low",
      risk: "high",
      safety_class: "write",
      read_only: false,
    });
    expect(contract.governance.dimensions.network.access).toBe("write");
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

  it("projects core Commander metadata into the same command contract without adapter-only repair fields", () => {
    const coreCommand = getCoreDiscoveryCommand("compute", "capture");
    expect(coreCommand).toBeDefined();

    const contract = buildCoreCommandContract({ command: coreCommand! });

    expect(contract).toMatchObject({
      schema_version: "command-contract.v1",
      identity: {
        site: "compute",
        command: "capture",
        category: "desktop",
        tags: ["core", "desktop"],
        source_path: "src/commands/compute.ts",
      },
      auth: {
        strategy: "public",
        required: false,
      },
      effect: {
        target_surface: "desktop",
      },
      eval: {
        fixture_status: "unknown",
        live_status: "unknown",
        health_status: "unknown",
      },
      repair: {
        source_kind: "core",
        source_path: "src/commands/compute.ts",
        quarantined: false,
      },
    });
    expect(contract.schemas.input.properties.format).toMatchObject({
      type: "string",
      default: "compact",
      enum: ["compact", "tree", "json"],
    });
    expect(contract.repair).not.toHaveProperty("adapter_path");
    expect(contract.repair).not.toHaveProperty("repair_command");
  });

  it("makes describe payloads expose core command contracts through the runtime describe boundary", () => {
    const payload = describeUnicli("compute", "capture").payload as {
      command: string;
      source_path?: string;
      adapter_path?: string;
      contract?: ReturnType<typeof buildCoreCommandContract>;
    };

    expect(payload.command).toBe("unicli compute capture");
    expect(payload.source_path).toBe("src/commands/compute.ts");
    expect(payload.adapter_path).toBeUndefined();
    expect(payload.contract).toMatchObject({
      schema_version: "command-contract.v1",
      identity: {
        site: "compute",
        command: "capture",
        source_path: "src/commands/compute.ts",
      },
      repair: {
        source_kind: "core",
        source_path: "src/commands/compute.ts",
      },
    });
  });

  it("describes core compute action args with ref provenance from the shared contract", () => {
    const click = describeUnicli("compute", "click").payload as {
      args_schema: {
        properties: Record<string, { description?: string; type: string }>;
        required: string[];
      };
      channels: { shell: string };
    };
    const type = describeUnicli("compute", "type").payload as {
      args_schema: { required: string[] };
      channels: { shell: string };
    };
    const press = describeUnicli("compute", "press").payload as {
      args_schema: { required: string[] };
      channels: { shell: string };
    };
    const scroll = describeUnicli("compute", "scroll").payload as {
      args_schema: {
        properties: Record<string, { default?: unknown; type: string }>;
        required: string[];
      };
      channels: { shell: string };
    };

    expect(click.args_schema.required).toEqual(["ref"]);
    expect(click.args_schema.properties.ref).toMatchObject({
      type: "string",
    });
    expect(click.args_schema.properties.ref.description).toContain(
      "olo:accessibility",
    );
    expect(click.args_schema.properties.background).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(click.channels.shell).toContain("<ref>");
    expect(type.args_schema.required).toEqual(["ref", "text"]);
    expect(type.channels.shell).toContain("<ref> <text>");
    expect(press.args_schema.required).toEqual(["combo"]);
    expect(press.channels.shell).toContain("<combo>");
    expect(scroll.args_schema.required).toEqual(["ref"]);
    expect(scroll.args_schema.properties.direction).toMatchObject({
      type: "string",
      default: "down",
    });
    expect(scroll.args_schema.properties.amount).toMatchObject({
      type: "integer",
      default: 300,
    });
  });

  it("exports the contract builders through the core barrel", () => {
    expect(typeof core.buildCommandContract).toBe("function");
    expect(typeof core.buildCoreCommandContract).toBe("function");
    expect(typeof core.lintCommandContract).toBe("function");
  });
});
