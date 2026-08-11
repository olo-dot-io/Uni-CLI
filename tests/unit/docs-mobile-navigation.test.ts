import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");

describe("mobile documentation navigation", () => {
  it("scopes the navigation card away from the hamburger icon container", () => {
    const css = readFileSync(
      join(ROOT, "docs/.vitepress/theme/custom.css"),
      "utf8",
    );

    expect(css).toContain(".VPNavBar > .wrapper > .container {");
    expect(css).not.toMatch(/^\.VPNavBar \.container \{/m);
  });
});
