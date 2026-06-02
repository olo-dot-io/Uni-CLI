import { describe, expect, it } from "vitest";

import {
  buildSiteProbePlans,
  classifyCommand,
} from "../../scripts/site-availability-sweep.js";
import { healthProbeArgs } from "../../scripts/adapter-health-shared.js";
import {
  AdapterType,
  Strategy,
  type AdapterManifest,
} from "../../src/types.js";

describe("site availability sweep", () => {
  it("selects one safe representative read probe per site", () => {
    const adapter: AdapterManifest = {
      name: "sweep-fixture",
      type: AdapterType.WEB_API,
      commands: {
        search: {
          name: "search",
          description: "Search items",
          adapterArgs: [{ name: "query", type: "str", required: true }],
        },
        top: {
          name: "top",
          description: "List top items",
          adapterArgs: [{ name: "limit", type: "int", default: 20 }],
          pipeline: [],
        },
        create: {
          name: "create",
          description: "Create item",
          adapterArgs: [{ name: "text", type: "str", required: true }],
        },
      },
    };

    const { sitePlans, commandPostureCounts } = buildSiteProbePlans([adapter]);

    expect(sitePlans).toHaveLength(1);
    expect(sitePlans[0]?.probe).toEqual({
      command: "top",
      args: { limit: 1 },
    });
    expect(commandPostureCounts.auto_runnable_read).toBe(1);
    expect(commandPostureCounts.requires_input).toBe(1);
    expect(commandPostureCounts.write_or_destructive).toBe(1);
  });

  it("keeps auth, browser, platform, and detect-gated commands out of auto probes", () => {
    const adapter: AdapterManifest = {
      name: "blocked-fixture",
      type: AdapterType.WEB_API,
      strategy: Strategy.PUBLIC,
      commands: {
        authRead: {
          name: "authRead",
          description: "List private items",
          strategy: Strategy.COOKIE,
        },
        browserRead: {
          name: "browserRead",
          description: "List browser items",
          browser: true,
        },
        platformRead: {
          name: "platformRead",
          description: "List Windows items",
          minimum_capability: "desktop-uia.snapshot",
        },
        cdpRead: {
          name: "cdpRead",
          description: "List CDP items",
          minimum_capability: "cdp-browser.evaluate",
        },
        websocketRead: {
          name: "websocketRead",
          description: "List WebSocket items",
          minimum_capability: "net.websocket",
        },
        detectRead: {
          name: "detectRead",
          description: "List host-gated items",
        },
      },
    };

    expect(
      classifyCommand({
        adapter,
        commandName: "authRead",
        command: adapter.commands.authRead!,
      }).posture,
    ).toBe("auth_required");
    expect(
      classifyCommand({
        adapter,
        commandName: "browserRead",
        command: adapter.commands.browserRead!,
      }).posture,
    ).toBe("browser_required");
    expect(
      classifyCommand({
        adapter,
        commandName: "platformRead",
        command: adapter.commands.platformRead!,
        platform: "darwin",
      }).posture,
    ).toBe("platform_mismatch");
    expect(
      classifyCommand({
        adapter,
        commandName: "cdpRead",
        command: adapter.commands.cdpRead!,
      }).posture,
    ).toBe("browser_required");
    expect(
      classifyCommand({
        adapter,
        commandName: "websocketRead",
        command: adapter.commands.websocketRead!,
      }).posture,
    ).toBe("environment_missing");
    expect(
      classifyCommand({
        adapter,
        commandName: "detectRead",
        command: adapter.commands.detectRead!,
        detectReason: "detect gate failed: `command -v missing-binary`",
      }).posture,
    ).toBe("environment_missing");
  });

  it("records why a site has no automatic probe", () => {
    const adapter: AdapterManifest = {
      name: "input-only-fixture",
      type: AdapterType.WEB_API,
      commands: {
        profile: {
          name: "profile",
          description: "Read profile",
          adapterArgs: [{ name: "id", type: "str", required: true }],
        },
      },
    };

    const { sitePlans } = buildSiteProbePlans([adapter]);

    expect(sitePlans[0]).toMatchObject({
      site: "input-only-fixture",
      primary_unprobed_reason: "requires_input",
      primary_unprobed_detail: "requires args without default: id",
    });
    expect(sitePlans[0]?.probe).toBeUndefined();
  });

  it("treats optional semantic inputs as non-runnable without a caller objective", () => {
    const adapter: AdapterManifest = {
      name: "semantic-input-fixture",
      type: AdapterType.WEB_API,
      commands: {
        author: {
          name: "author",
          description: "List author records by author or pid",
          adapterArgs: [
            { name: "author", type: "str", positional: true },
            { name: "pid", type: "str" },
            { name: "limit", type: "int", default: 20 },
          ],
        },
      },
    };

    expect(
      classifyCommand({
        adapter,
        commandName: "author",
        command: adapter.commands.author!,
      }),
    ).toMatchObject({
      posture: "requires_input",
      reason: "requires semantic input without default: author, pid",
    });
  });

  it("matches CLI limit typing for untyped adapter limit args", () => {
    expect(
      healthProbeArgs({
        name: "latest",
        adapterArgs: [{ name: "limit" }],
      }).limit,
    ).toBe("1");
  });
});
