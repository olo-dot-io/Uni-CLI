/**
 * @owner   tests/unit/package-registry-surface.test.ts
 * @does    Assert Feature 3.3 package registry adapters stay active in the real registry.
 * @needs   src/adapters package-registry YAML files, src/discovery/loader.ts, src/registry.ts
 * @feeds   Feature 3.3 site expansion gate, npm run test
 * @breaks  Missing, quarantined, or auth-gated package registries shrink agent package discovery.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SITE_CATEGORIES } from "../../src/discovery/aliases.js";
import { loadAllAdapters } from "../../src/discovery/loader.js";
import { runPipeline } from "../../src/engine/executor.js";
import "../../src/engine/steps/index.js";
import { listCommands } from "../../src/registry.js";

const EXPECTED_PACKAGE_REGISTRIES = {
  maven: ["artifact", "info", "search"],
  nuget: ["info", "package", "search"],
  rubygems: ["gem", "info", "search"],
  packagist: ["info", "package", "search"],
  "pub-dev": ["info", "search"],
} as const;

const ROOT = process.cwd();

interface ParsedAdapter {
  pipeline: Array<Record<string, unknown>>;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });

    if (req.url === "/packagist.json") {
      res.end(
        JSON.stringify({
          package: {
            name: "laravel/framework",
            description: "The Laravel Framework.",
            time: "2026-05-05T00:00:00+00:00",
            repository: "https://github.com/laravel/framework",
            versions: {
              "12.0.0": { version: "12.0.0" },
              "11.0.0": { version: "11.0.0" },
            },
          },
        }),
      );
      return;
    }

    if (req.url === "/pub-dev.json") {
      res.end(
        JSON.stringify({
          name: "http",
          latest: {
            version: "1.4.0",
            pubspec: {
              description: "A composable, multi-platform HTTP client.",
              repository: "https://github.com/dart-lang/http",
              homepage: "https://pub.dev/packages/http",
            },
          },
          versions: [{ version: "1.4.0" }, { version: "1.3.0" }],
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address && typeof address === "object") {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterAll(() => {
  server.close();
});

function readAdapter(site: string, command: string): ParsedAdapter {
  const raw = readFileSync(
    join(ROOT, "src", "adapters", site, `${command}.yaml`),
    "utf-8",
  );
  return yaml.load(raw) as ParsedAdapter;
}

function pipelineWithFixture(
  site: string,
  command: string,
  fixturePath: string,
): Array<Record<string, unknown>> {
  const [, ...rest] = readAdapter(site, command).pipeline;
  return [{ fetch: { url: `${baseUrl}${fixturePath}` } }, ...rest];
}

describe("package registry expansion surfaces", () => {
  it("registers five active public package registry sites", () => {
    loadAllAdapters();
    const commands = listCommands();

    for (const [site, expectedCommands] of Object.entries(
      EXPECTED_PACKAGE_REGISTRIES,
    )) {
      const siteCommands = commands.filter((command) => command.site === site);
      expect(
        siteCommands.map((command) => command.command).sort(),
        `${site} commands`,
      ).toEqual(expectedCommands);

      for (const command of siteCommands) {
        expect(SITE_CATEGORIES.get(site), `${site} category`).toBe("dev");
        expect(command.auth, `${site}/${command.command} auth`).toBe(false);
        expect(
          command.quarantined,
          `${site}/${command.command} quarantine`,
        ).toBe(false);
      }
    }
  });

  it("projects singleton package info payloads into bounded rows", async () => {
    const packagist = await runPipeline(
      pipelineWithFixture("packagist", "info", "/packagist.json"),
      { args: { package: "laravel/framework" }, source: "internal" },
    );
    const pubDev = await runPipeline(
      pipelineWithFixture("pub-dev", "info", "/pub-dev.json"),
      { args: { package: "http" }, source: "internal" },
    );

    expect(packagist).toEqual([
      {
        name: "laravel/framework",
        description: "The Laravel Framework.",
        time: "2026-05-05T00:00:00+00:00",
        repository: "https://github.com/laravel/framework",
        versions: "2",
      },
    ]);
    expect(pubDev).toEqual([
      {
        name: "http",
        version: "1.4.0",
        description: "A composable, multi-platform HTTP client.",
        repository: "https://github.com/dart-lang/http",
        homepage: "https://pub.dev/packages/http",
        versions: "2",
      },
    ]);
  });
});
