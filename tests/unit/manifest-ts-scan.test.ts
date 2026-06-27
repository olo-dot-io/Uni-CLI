import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractTsRegistrations } from "../../scripts/manifest-ts-scan.js";

describe("manifest TS scanner", () => {
  it("expands literal for-of cli registrations without emitting fallback web commands", () => {
    const source = `
      import { cli, Strategy } from "../../src/registry.js";

      const ARGS = [
        { name: "query", type: "str" as const, required: true, positional: true },
        { name: "limit", type: "int" as const, default: 10 },
      ];
      const COLUMNS = ["rank", "title", "url"];

      for (const name of ["anime", "manga"] as const) {
        cli({
          site: "kitsu",
          name,
          description: \`Search Kitsu \${name} by Japanese title, romaji, or alias\`,
          domain: "kitsu.io",
          strategy: Strategy.PUBLIC,
          browser: false,
          args: ARGS,
          columns: COLUMNS,
          defaultFormat: "json",
        });
      }
    `;

    const registrations = extractTsRegistrations(source, "kitsu", "web");
    const commands = registrations
      .filter((registration) => registration.site === "kitsu")
      .flatMap((registration) => registration.commands);

    expect(commands.map((command) => command.name).sort()).toEqual([
      "anime",
      "manga",
    ]);
    expect(commands).not.toContainEqual(
      expect.objectContaining({ name: "web" }),
    );
    expect(commands.find((command) => command.name === "anime")).toEqual(
      expect.objectContaining({
        description: "Search Kitsu anime by Japanese title, romaji, or alias",
        args: [
          expect.objectContaining({ name: "query", required: true }),
          expect.objectContaining({ name: "limit", default: 10 }),
        ],
        columns: ["rank", "title", "url"],
        defaultFormat: "json",
      }),
    );
  });

  it("expands tuple for-of cli registrations", () => {
    const source = `
      import { cli, Strategy } from "../../src/registry.js";

      for (const [name, label] of [
        ["citations", "paper citations"],
        ["references", "paper references"],
      ] as const) {
        cli({
          site: "semantic-scholar",
          name,
          description: \`List Semantic Scholar \${label}\`,
          domain: "api.semanticscholar.org",
          strategy: Strategy.PUBLIC,
        });
      }
    `;

    const registrations = extractTsRegistrations(
      source,
      "semantic-scholar",
      "papers",
    );
    const commands = registrations
      .filter((registration) => registration.site === "semantic-scholar")
      .flatMap((registration) => registration.commands);

    expect(commands.map((command) => command.name).sort()).toEqual([
      "citations",
      "references",
    ]);
    expect(commands.find((command) => command.name === "citations")).toEqual(
      expect.objectContaining({
        description: "List Semantic Scholar paper citations",
      }),
    );
  });

  it("keeps TypeScript command capability metadata in generated manifests", () => {
    const source = `
      import { cli, Strategy } from "../../src/registry.js";

      cli({
        site: "openreview",
        name: "read",
        description: "Download and extract text from an OpenReview paper PDF",
        domain: "openreview.net",
        strategy: Strategy.PUBLIC,
        capabilities: ["http.fetch", "http.download", "subprocess.exec", "scholar.fulltext"],
        executables: ["pdftotext"],
        minimum_capability: "subprocess.exec",
        args: [{ name: "id", type: "str" as const, required: true, positional: true }],
        columns: ["id", "text"],
        func: async () => [],
      });
    `;

    const registrations = extractTsRegistrations(
      source,
      "openreview",
      "papers",
    );
    const command = registrations
      .filter((registration) => registration.site === "openreview")
      .flatMap((registration) => registration.commands)
      .find((candidate) => candidate.name === "read");

    expect(command).toEqual(
      expect.objectContaining({
        capabilities: [
          "http.fetch",
          "http.download",
          "subprocess.exec",
          "scholar.fulltext",
        ],
        executables: ["pdftotext"],
        minimum_capability: "subprocess.exec",
      }),
    );
  });

  it("resolves imported TS array constants and spread elements for command schemas", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-manifest-scan-"));
    try {
      const sharedPath = join(dir, "shared.ts");
      const entryPath = join(dir, "entry.ts");
      writeFileSync(
        sharedPath,
        `
        export const BASE_COLUMNS = ["rank", "title"];
        export const SEARCH_COLUMNS = [...BASE_COLUMNS, "url"];
        export const BASE_ARGS = [
          { name: "query", type: "str" as const, required: true, positional: true },
        ];
        export const SEARCH_ARGS = [
          ...BASE_ARGS,
          { name: "limit", type: "int" as const, default: 20 },
        ];
        export const SEARCH_CAPABILITIES = ["http.fetch", "scholar.search"] as const;
      `,
      );
      writeFileSync(
        entryPath,
        `
        import { cli, Strategy } from "../../src/registry.js";
        import {
          SEARCH_ARGS,
          SEARCH_CAPABILITIES,
          SEARCH_COLUMNS,
        } from "./shared.js";

        cli({
          site: "example-scholar",
          name: "search",
          description: "Search an example scholarly source",
          domain: "example.test",
          strategy: Strategy.PUBLIC,
          args: SEARCH_ARGS,
          columns: SEARCH_COLUMNS,
          capabilities: SEARCH_CAPABILITIES,
          func: async () => [],
        });
      `,
      );

      const registrations = extractTsRegistrations(
        readFileSync(entryPath, "utf-8"),
        "example-scholar",
        "entry",
        { sourcePath: entryPath },
      );
      const command = registrations
        .filter((registration) => registration.site === "example-scholar")
        .flatMap((registration) => registration.commands)
        .find((candidate) => candidate.name === "search");

      expect(command).toEqual(
        expect.objectContaining({
          args: [
            expect.objectContaining({
              name: "query",
              required: true,
              positional: true,
            }),
            expect.objectContaining({ name: "limit", default: 20 }),
          ],
          columns: ["rank", "title", "url"],
          capabilities: ["http.fetch", "scholar.search"],
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
