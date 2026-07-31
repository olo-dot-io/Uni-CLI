import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerBrowserCommands } from "../../../src/commands/browser/index.js";
import {
  BROWSER_OPERATION_SPECS,
  browserOperationShell,
  getBrowserOperationSpec,
} from "../../../src/commands/browser/operation-spec.js";
import { getCoreDiscoveryCommand } from "../../../src/discovery/core-catalog.js";
import { buildCoreCommandContract } from "../../../src/core/command-contract.js";
import { describe as describeUnicli } from "../../../src/commands/describe.js";

function registeredBrowserCommand(path: string): Command {
  const program = new Command();
  registerBrowserCommands(program);
  let current = program.commands.find(
    (command) => command.name() === "browser",
  );
  expect(current).toBeDefined();
  for (const segment of path.split(" ")) {
    current = current?.commands.find((command) => command.name() === segment);
    expect(current, `missing browser command path: ${path}`).toBeDefined();
  }
  return current!;
}

function browserRelativePath(command: Command): string {
  const segments: string[] = [];
  let current: Command | null = command;
  while (current && current.name() !== "browser") {
    segments.push(current.name());
    current = current.parent;
  }
  expect(current?.name()).toBe("browser");
  return segments.reverse().join(" ");
}

describe("browser operation spec", () => {
  it("maps unique declared operations to real Commander paths in both directions", () => {
    expect(
      new Set(BROWSER_OPERATION_SPECS.map((spec) => spec.command)).size,
    ).toBe(BROWSER_OPERATION_SPECS.length);
    for (const spec of BROWSER_OPERATION_SPECS) {
      const current = registeredBrowserCommand(spec.command);
      expect(
        current.commands,
        `operation must resolve to a leaf: ${spec.command}`,
      ).toHaveLength(0);
      expect(getBrowserOperationSpec(browserRelativePath(current))).toBe(spec);
    }
  });

  it("keeps every command-local positional and option aligned with Commander", () => {
    for (const spec of BROWSER_OPERATION_SPECS) {
      const current = registeredBrowserCommand(spec.command);
      const actual = [
        ...current.registeredArguments.map((argument) => ({
          key: `positional:${argument.name()}`,
          name: argument.name(),
          positional: true,
          required: argument.required,
          takesValue: true,
        })),
        ...current.options.map((commandOption) => ({
          key: `option:${commandOption.flags}`,
          name: commandOption.attributeName(),
          positional: false,
          required: commandOption.mandatory,
          takesValue: commandOption.required || commandOption.optional,
        })),
      ];
      const declared = spec.args.map((arg) => ({
        key: arg.positional
          ? `positional:${arg.name}`
          : `option:${arg.flags ?? `--${arg.name}`}`,
        name: arg.name,
        positional: arg.positional === true,
        required: arg.required === true,
        takesValue: arg.positional === true || arg.type !== "bool",
      }));

      expect(
        declared,
        `argument contract drift for browser ${spec.command}`,
      ).toEqual(actual);
    }
  });

  it("projects the narrow provider, scope, verb, and effect into discovery", () => {
    for (const spec of BROWSER_OPERATION_SPECS) {
      const row = getCoreDiscoveryCommand("browser", spec.command);
      expect(
        row,
        `missing discovery row: browser ${spec.command}`,
      ).toBeDefined();
      const contract = buildCoreCommandContract({ command: row! });
      expect(contract.execution).toMatchObject({
        operator: spec.execution_operator,
        provider: "cdp-browser",
        target_scope: "browser-renderer",
      });
      expect(contract.operation).toMatchObject({
        family: spec.operation_family,
        source: "declared",
        confidence: "high",
      });
      expect(contract.effect.operation_effect).toBe(spec.operation_effect);
      expect(contract.effect.idempotency).toBe(spec.idempotency);
      expect(contract.schemas.input.required).toEqual(
        spec.args.filter((arg) => arg.required).map((arg) => arg.name),
      );
      expect(row?.channels?.shell).toBe(browserOperationShell(spec));
    }
  });

  it("declares conservative file effects for cache and evidence writers", () => {
    const contract = (command: string) =>
      buildCoreCommandContract({
        command: getCoreDiscoveryCommand("browser", command)!,
      });

    expect(contract("observe").effect).toMatchObject({
      operation_effect: "local_file",
      idempotency: "none",
      read_only: false,
    });
    expect(contract("network").effect).toMatchObject({
      operation_effect: "local_file",
      idempotency: "conditional",
      read_only: false,
    });
    expect(contract("extract").effect).toMatchObject({
      operation_effect: "download_file",
      idempotency: "none",
      read_only: false,
    });
  });

  it("describes a runnable shell template and closed input schema", () => {
    const result = describeUnicli("browser", "click");
    const payload = result.payload as {
      args_schema: {
        properties: Record<string, unknown>;
        required: string[];
      };
      channels: { shell: string };
      example_stdin: Record<string, unknown>;
    };

    expect(result.exit).toBe(0);
    expect(payload.args_schema.required).toEqual(["ref"]);
    expect(payload.args_schema.properties).toHaveProperty("ref");
    expect(payload.example_stdin).toEqual({ ref: "<ref>" });
    expect(payload.channels.shell).toBe("unicli browser click <ref>");
  });
});
