import { describe, expect, it } from "vitest";

import { defaultErrorNextActions } from "../../../src/output/next-actions.js";

describe("error next_actions", () => {
  it("gives concrete auth import, browser login, and auth-retry commands", () => {
    const commands = defaultErrorNextActions(
      "zhihu",
      "comment",
      "auth_required",
    ).map((action) => action.command);

    expect(commands).toContain(
      "unicli auth import zhihu --domain www.zhihu.com",
    );
    expect(commands).toContain("unicli browser open https://www.zhihu.com");
    expect(commands).toContain(
      "unicli --auth-retry zhihu comment --args-file <path.json>",
    );
  });

  it("uses adapter domain metadata instead of inventing a .com domain", () => {
    const commands = defaultErrorNextActions(
      "openreview",
      "paper",
      "challenge_required",
      "openreview.net",
    ).map((action) => action.command);

    expect(commands).toContain("unicli browser open https://openreview.net");
    expect(commands).toContain(
      "unicli browser cookies openreview.net --save-as openreview",
    );
    expect(commands).not.toContain(
      "unicli auth import openreview --domain openreview.net",
    );
    expect(
      commands.every((command) => !command.includes("openreview.com")),
    ).toBe(true);
  });

  it("never recommends adapter repair for network or authentication failures", () => {
    for (const code of ["network_error", "rate_limited", "auth_required"]) {
      const commands = defaultErrorNextActions("hackernews", "top", code).map(
        (action) => action.command,
      );
      expect(commands).not.toContain("unicli repair hackernews top");
    }
  });

  it("offers repair only as the verifier for established adapter drift", () => {
    const action = defaultErrorNextActions(
      "hackernews",
      "top",
      "selector_miss",
    ).find((candidate) => candidate.command === "unicli repair hackernews top");

    expect(action?.description).toContain(
      "Verify an evidence-backed adapter fix",
    );
  });
});
