import { describe, it, expect } from "vitest";
import { dedupeBanner } from "../../scripts/dedupe-yaml-banner.js";

const BANNER = "# schema-v2 metadata — injected by `unicli migrate schema-v2`";

describe("dedupeBanner", () => {
  it("returns null when the file has no banner", () => {
    const src = `site: x
name: y
pipeline: []
`;
    expect(dedupeBanner(src)).toBeNull();
  });

  it("returns null for single-banner files (idempotent)", () => {
    const src = `site: x
name: y

${BANNER}
schema_version: v2
`;
    expect(dedupeBanner(src)).toBeNull();
  });

  it("coalesces the canonical v0.212+v0.213 duplicate pattern", () => {
    const src = `site: unsplash
name: search
pipeline: []

${BANNER}
capabilities: ["http.fetch"]
trust: public
quarantine: false

${BANNER}
schema_version: v2
`;
    const out = dedupeBanner(src);
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    // Exactly one banner remains.
    expect(lines.filter((l) => l === BANNER)).toHaveLength(1);
    // `schema_version: v2` is preserved.
    expect(lines).toContain("schema_version: v2");
    // The preserved fields survived.
    expect(out).toContain("capabilities:");
    expect(out).toContain("trust: public");
    expect(out).toContain("quarantine: false");
  });

  it("leaves the banner alone when not immediately followed by schema_version: v2", () => {
    // Defensive: if some adapter evolved past the known pattern, don't touch it.
    const src = `site: x
${BANNER}
some_other_field: true

${BANNER}
schema_version: v3
`;
    expect(dedupeBanner(src)).toBeNull();
  });
});
