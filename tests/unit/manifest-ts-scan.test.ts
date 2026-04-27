import { describe, expect, it } from "vitest";

import { extractTsRegistrations } from "../../scripts/manifest-ts-scan.js";

describe("manifest TS scanner", () => {
  it("emits argument schemas for generated Electron desktop commands", () => {
    const source = `
      import { registerElectronDesktopCommands } from "../_electron/desktop-shared.js";

      registerElectronDesktopCommands("wechat-work", { displayName: "WeCom" });
    `;

    const registrations = extractTsRegistrations(
      source,
      "electron-desktop",
      "electron-desktop",
    );
    const commands = registrations
      .filter((registration) => registration.site === "wechat-work")
      .flatMap((registration) => registration.commands);

    expect(commands.find((command) => command.name === "click-text")).toEqual(
      expect.objectContaining({
        adapter_path: "src/adapters/electron-desktop/electron-desktop.ts",
        target_surface: "desktop",
        args: [
          expect.objectContaining({
            name: "text",
            required: true,
            positional: true,
          }),
        ],
      }),
    );
    expect(commands.find((command) => command.name === "type-text")).toEqual(
      expect.objectContaining({
        adapter_path: "src/adapters/electron-desktop/electron-desktop.ts",
        target_surface: "desktop",
        args: [
          expect.objectContaining({
            name: "text",
            required: true,
            positional: true,
          }),
          expect.objectContaining({
            name: "target",
            required: false,
            positional: false,
          }),
        ],
      }),
    );
    expect(commands.find((command) => command.name === "press")).toEqual(
      expect.objectContaining({
        args: [
          expect.objectContaining({
            name: "key",
            required: true,
            positional: true,
          }),
          expect.objectContaining({
            name: "modifiers",
            required: false,
            positional: false,
          }),
        ],
      }),
    );
  });

  it("emits AI chat defaults and desktop target metadata", () => {
    const source = `
      import { registerAIChatCommands } from "../_electron/shared.js";

      registerAIChatCommands("chatgpt", {
        displayName: "ChatGPT",
        modelSelector: "[data-testid=model]",
      });
    `;

    const registrations = extractTsRegistrations(source, "chatgpt", "chatgpt");
    const commands = registrations
      .filter((registration) => registration.site === "chatgpt")
      .flatMap((registration) => registration.commands);

    expect(commands.find((command) => command.name === "ask")).toEqual(
      expect.objectContaining({
        adapter_path: "src/adapters/chatgpt/chatgpt.ts",
        target_surface: "desktop",
        args: [
          expect.objectContaining({
            name: "prompt",
            required: true,
            positional: true,
          }),
        ],
      }),
    );
    expect(commands.find((command) => command.name === "screenshot")).toEqual(
      expect.objectContaining({
        adapter_path: "src/adapters/chatgpt/chatgpt.ts",
        target_surface: "desktop",
        args: [
          expect.objectContaining({
            name: "path",
            default: "./chatgpt-screenshot.png",
          }),
        ],
      }),
    );
    expect(commands.find((command) => command.name === "model")).toEqual(
      expect.objectContaining({
        target_surface: "desktop",
        args: [
          expect.objectContaining({
            name: "name",
            required: false,
            positional: true,
          }),
        ],
      }),
    );
  });
});
