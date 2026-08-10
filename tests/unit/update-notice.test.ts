import { afterEach, describe, expect, it } from "vitest";

import {
  buildAgentUpdateNotice,
  clearActiveUpdateNotice,
  setActiveUpdateNotice,
} from "../../src/core/update-notice.js";
import { format } from "../../src/output/formatter.js";

afterEach(() => {
  clearActiveUpdateNotice();
});

describe("Agent update notice", () => {
  it("adds an actionable update to JSON and Markdown envelopes", () => {
    setActiveUpdateNotice(
      buildAgentUpdateNotice("1.0.4", "1.1.0", {
        enabled: true,
        status: "scheduled",
        package_manager: "npm",
        opt_out: "UNICLI_AUTO_UPDATE=0",
      }),
    );
    const ctx = {
      command: "core.search",
      duration_ms: 4,
      surface: "web" as const,
    };

    const json = JSON.parse(format([], undefined, "json", ctx));
    expect(json.meta.update).toMatchObject({
      status: "available",
      current: "1.0.4",
      latest: "1.1.0",
      unattended_command: "unicli upgrade --yes",
      decline_command: "unicli upgrade --no",
      automatic_update: {
        enabled: true,
        status: "scheduled",
        opt_out: "UNICLI_AUTO_UPDATE=0",
      },
    });
    expect(json.next_actions).toBeUndefined();

    const markdown = format([], undefined, "md", ctx);
    expect(markdown).toContain("update_available: true");
    expect(markdown).toContain("## Update Available");
    expect(markdown).toContain("unicli upgrade --yes");
    expect(markdown).toContain("unicli upgrade --no");
    expect(markdown).toContain("Automatic update**: scheduled");
    expect(markdown).toContain("UNICLI_AUTO_UPDATE=0");

    setActiveUpdateNotice(
      buildAgentUpdateNotice("1.0.4", "1.1.0", {
        enabled: false,
        status: "disabled",
        opt_out: "UNICLI_AUTO_UPDATE=0",
      }),
    );
    const explicit = JSON.parse(format([], undefined, "json", ctx));
    expect(explicit.next_actions).toContainEqual({
      command: "unicli upgrade --yes",
      description:
        "Upgrade Uni-CLI from 1.0.4 to 1.1.0, then retry the original task.",
    });
  });
});
