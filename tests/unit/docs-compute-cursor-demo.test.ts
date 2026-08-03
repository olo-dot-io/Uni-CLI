import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("docs compute cursor demo", () => {
  it("uses a real visual_action fixture as the replay source", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          repoRoot,
          "docs/.vitepress/theme/fixtures/compute-visual-action.json",
        ),
        "utf8",
      ),
    ) as {
      visual_action?: {
        schema_version?: number;
        pointer_plan?: { samples?: unknown[] };
        overlay?: { provider?: string; status?: string };
        dispatch?: { status?: string; transport?: string };
        post_capture?: { ok?: boolean };
      };
    };
    const component = readFileSync(
      join(repoRoot, "docs/.vitepress/theme/components/ComputeCursorDemo.vue"),
      "utf8",
    );

    expect(fixture.visual_action).toMatchObject({
      schema_version: 2,
      overlay: { provider: "macos-appkit", status: "arrived" },
      dispatch: { status: "succeeded" },
      post_capture: { ok: true },
    });
    expect(
      fixture.visual_action?.pointer_plan?.samples?.length,
    ).toBeGreaterThan(2);
    expect(component).toContain(
      'from "../fixtures/compute-visual-action.json"',
    );
    expect(component).toContain("replaySteps");
    expect(component).toContain("pointerPlan");
  });

  it("documents the native system overlay evidence path honestly", () => {
    const docs = readFileSync(
      join(repoRoot, "docs/operate/compute.md"),
      "utf8",
    );

    expect(docs).toContain("System Overlay HUD");
    expect(docs).toContain("unicli doctor compute --json");
    expect(docs).toContain("overlay/macos-appkit");
    expect(docs).toContain("overlay/windows-win32");
    expect(docs).toContain("overlay/linux-gtk");
    expect(docs).toContain("unicli -f json compute click @e13 --overlay");
    expect(docs).toContain("visual_action.post_capture");
    expect(docs).toContain("Chrome extension");
    expect(docs).toContain("cannot cover arbitrary macOS apps");
    expect(docs).toContain("Accessibility and Screen Recording");
  });
});
