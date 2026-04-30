import { describe, expect, it } from "vitest";

import {
  buildMacosAutomationSmoke,
  buildMacosDynamicCommands,
  buildMacosDynamicSearchDocuments,
  filterMacosAppActions,
  parseShortcutsListOutput,
  parseToolKitActionsJson,
} from "../../src/discovery/macos-dynamic.js";

describe("macOS dynamic discovery", () => {
  it("parses Shortcuts CLI names and identifiers", () => {
    const shortcuts = parseShortcutsListOutput(
      [
        "Show Screenshots (02FBD635-5A5F-44EA-8C65-DCB8ADF31E01)",
        "一键录音 (95FECF9F-515F-44F4-9CB4-2C4629F33DB5)",
        "What’s a shortcut?",
      ].join("\n"),
    );

    expect(shortcuts).toEqual([
      {
        name: "Show Screenshots",
        identifier: "02FBD635-5A5F-44EA-8C65-DCB8ADF31E01",
      },
      {
        name: "一键录音",
        identifier: "95FECF9F-515F-44F4-9CB4-2C4629F33DB5",
      },
      {
        name: "What’s a shortcut?",
      },
    ]);
  });

  it("parses ToolKit app actions from sqlite JSON output", () => {
    const actions = parseToolKitActionsJson(
      JSON.stringify([
        {
          id: "net.whatsapp.WhatsApp.EndCallIntent",
          kind: "appIntent",
          container_id: "net.whatsapp.WhatsApp",
          app: "WhatsApp",
          name: "End call",
          description: "End the current WhatsApp call.",
        },
      ]),
    );

    expect(actions).toEqual([
      {
        id: "net.whatsapp.WhatsApp.EndCallIntent",
        kind: "appIntent",
        containerId: "net.whatsapp.WhatsApp",
        app: "WhatsApp",
        name: "End call",
        description: "End the current WhatsApp call.",
      },
    ]);
  });

  it("turns local shortcuts and app actions into discoverable commands", () => {
    const commands = buildMacosDynamicCommands({
      shortcuts: [
        {
          name: "Show Screenshots",
          identifier: "02FBD635-5A5F-44EA-8C65-DCB8ADF31E01",
        },
      ],
      appActions: [
        {
          id: "net.whatsapp.WhatsApp.EndCallIntent",
          kind: "appIntent",
          containerId: "net.whatsapp.WhatsApp",
          app: "WhatsApp",
          name: "End call",
          description: "End the current WhatsApp call.",
        },
      ],
    });

    expect(commands["shortcut-show-screenshots"]).toMatchObject({
      name: "shortcut-show-screenshots",
      description: 'Run local Shortcuts.app shortcut "Show Screenshots"',
      adapter_path: "dynamic:macos-shortcuts",
    });
    expect(commands["app-action-whatsapp-end-call"]).toMatchObject({
      name: "app-action-whatsapp-end-call",
      description:
        "Inspect Shortcuts app action WhatsApp / End call. End the current WhatsApp call.",
      adapter_path: "dynamic:macos-app-actions",
    });
  });

  it("filters common app actions by app and query", () => {
    const actions = [
      {
        id: "net.whatsapp.WhatsApp.EndCallIntent",
        kind: "appIntent",
        containerId: "net.whatsapp.WhatsApp",
        app: "WhatsApp",
        name: "End call",
        description: "End the current WhatsApp call.",
      },
      {
        id: "com.apple.Safari.OpenTab",
        kind: "appIntent",
        containerId: "com.apple.Safari",
        app: "Safari",
        name: "Open Tab",
        description: "Open a Safari tab.",
      },
      {
        id: "com.apple.MobileSMS.SendMessage",
        kind: "appIntent",
        containerId: "com.apple.MobileSMS",
        app: "Messages",
        name: "Send Message",
        description: "Send a message.",
      },
    ];

    expect(filterMacosAppActions(actions, { app: "whatsapp" })).toEqual([
      actions[0],
    ]);
    expect(filterMacosAppActions(actions, { query: "send" })).toEqual([
      actions[2],
    ]);
    expect(filterMacosAppActions(actions, { limit: 2 })).toHaveLength(2);
  });

  it("summarizes CLI, API, and AX smoke status for common apps", () => {
    const smoke = buildMacosAutomationSmoke(
      {
        shortcuts: [{ name: "Show Screenshots" }],
        appActions: [
          {
            id: "net.whatsapp.WhatsApp.EndCallIntent",
            kind: "appIntent",
            containerId: "net.whatsapp.WhatsApp",
            app: "WhatsApp",
            name: "End call",
            description: "",
          },
          {
            id: "com.apple.Safari.OpenTab",
            kind: "appIntent",
            containerId: "com.apple.Safari",
            app: "Safari",
            name: "Open Tab",
            description: "",
          },
        ],
      },
      ["Finder", "Safari"],
      ["Finder", "Safari", "WhatsApp"],
    );

    expect(smoke.layers.map((layer) => layer.layer)).toEqual([
      "cli",
      "api",
      "ax",
    ]);
    expect(smoke.layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "cli", ok: true, count: 1 }),
        expect.objectContaining({ layer: "api", ok: true, count: 2 }),
        expect.objectContaining({ layer: "ax", ok: true, count: 2 }),
      ]),
    );
    expect(smoke.apps).toEqual([
      {
        app: "Finder",
        apiActions: 0,
        axRunning: true,
        sampleActions: [],
      },
      {
        app: "Safari",
        apiActions: 1,
        axRunning: true,
        sampleActions: ["Open Tab"],
      },
      {
        app: "WhatsApp",
        apiActions: 1,
        axRunning: false,
        sampleActions: ["End call"],
      },
    ]);
  });

  it("builds search documents for dynamic macOS actions", () => {
    const docs = buildMacosDynamicSearchDocuments({
      shortcuts: [
        {
          name: "Show Screenshots",
          identifier: "02FBD635-5A5F-44EA-8C65-DCB8ADF31E01",
        },
      ],
      appActions: [
        {
          id: "net.whatsapp.WhatsApp.EndCallIntent",
          kind: "appIntent",
          containerId: "net.whatsapp.WhatsApp",
          app: "WhatsApp",
          name: "End call",
          description: "End the current WhatsApp call.",
        },
      ],
    });

    expect(docs).toEqual(
      expect.arrayContaining([
        {
          site: "macos",
          command: "app-actions",
          description:
            "List real-time Shortcuts app actions, App Intents, app commands, action identifiers, and automation actions from installed macOS apps.",
        },
        {
          site: "macos",
          command: "automation-smoke",
          description:
            "Probe macOS automation layers across Shortcuts CLI, Shortcuts ToolKit API, Accessibility AX, System Events, and common apps.",
        },
        {
          site: "macos",
          command: "shortcut-show-screenshots",
          description:
            'Run local Shortcuts.app shortcut "Show Screenshots" via the macOS shortcuts CLI.',
        },
        {
          site: "macos",
          command: "app-action-whatsapp-end-call",
          description:
            "Shortcuts app action from WhatsApp: End call. End the current WhatsApp call.",
        },
      ]),
    );
  });
});
