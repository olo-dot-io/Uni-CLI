import { describe, expect, it } from "vitest";

import {
  commandOperatorProfile,
  resolveCommandOperator,
} from "../../src/core/operator-model.js";
import { AdapterType } from "../../src/types.js";

describe("command operator model", () => {
  it("lets an exact structured capability outrank a broad browser flag", () => {
    expect(
      resolveCommandOperator({
        adapterType: AdapterType.WEB_API,
        targetSurface: "web",
        browser: true,
        minimumCapability: "http.fetch",
      }),
    ).toMatchObject({
      operator: "structured-api",
      provider: "http-or-service-protocol",
      coordinate_actuation: false,
      selection_reason: "minimum capability http.fetch",
    });
  });

  it.each([
    ["subprocess.exec", "native-cli"],
    ["cdp-browser.evaluate", "browser-semantic"],
    ["desktop-ax.ax_press", "desktop-accessibility"],
    ["visual.click", "visual-coordinate"],
  ] as const)("maps %s to %s", (minimumCapability, operator) => {
    expect(
      resolveCommandOperator({
        targetSurface: "system",
        browser: false,
        minimumCapability,
      }).operator,
    ).toBe(operator);
  });

  it("supports an explicit local-runtime contract for local indexes", () => {
    expect(
      commandOperatorProfile(
        "local-runtime",
        "declared by the command contract",
      ),
    ).toMatchObject({
      operator: "local-runtime",
      perception: "local-state",
      actuation: "local-function",
      target_scope: "local-runtime",
    });
  });
});
