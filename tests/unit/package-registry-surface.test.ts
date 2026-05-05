/**
 * @owner   tests/unit/package-registry-surface.test.ts
 * @does    Assert Feature 3.3 package registry adapters stay active in the real registry.
 * @needs   src/adapters package-registry YAML files, src/discovery/loader.ts, src/registry.ts
 * @feeds   Feature 3.3 site expansion gate, npm run test
 * @breaks  Missing, quarantined, or auth-gated package registries shrink agent package discovery.
 */

import { describe, expect, it } from "vitest";
import { SITE_CATEGORIES } from "../../src/discovery/aliases.js";
import { loadAllAdapters } from "../../src/discovery/loader.js";
import { listCommands } from "../../src/registry.js";

const EXPECTED_PACKAGE_REGISTRIES = {
  maven: ["info", "search"],
  nuget: ["info", "search"],
  rubygems: ["info", "search"],
  packagist: ["info", "search"],
  "pub-dev": ["info", "search"],
} as const;

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
});
