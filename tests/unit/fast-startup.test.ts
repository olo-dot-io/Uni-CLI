import { describe, expect, it } from "vitest";

import { rootHelp } from "../../src/fast-startup.js";

describe("root startup help", () => {
  it("keeps discovery actionable without enumerating the adapter inventory", () => {
    const help = rootHelp();
    expect(help).toContain("Usage: unicli");
    expect(help).toContain("Open Agent-Computer Interface runtime");
    expect(help).toContain("search <intent...>");
    expect(help).toContain("list [--site <site>]");
    expect(help).toContain("unicli help <command>");
    expect(help).not.toContain("Commands for bilibili");
    expect(help.split("\n").length).toBeLessThan(40);
  });
});
