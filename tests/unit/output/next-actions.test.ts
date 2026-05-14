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
});
