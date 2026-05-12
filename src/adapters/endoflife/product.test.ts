import { describe, expect, it } from "vitest";
import {
  mapEndoflifeRows,
  normalizeEndoflifeDateOrFlag,
  requireEndoflifeProduct,
} from "./product.js";

describe("endoflife agent-facing product command", () => {
  it("validates product slugs", () => {
    expect(requireEndoflifeProduct(" NodeJS ")).toBe("nodejs");
    expect(requireEndoflifeProduct("ubuntu-24.04")).toBe("ubuntu-24.04");
    expect(() => requireEndoflifeProduct("../node")).toThrow("valid slug");
  });

  it("normalizes date and boolean lifecycle fields", () => {
    expect(normalizeEndoflifeDateOrFlag(true)).toBe("ongoing");
    expect(normalizeEndoflifeDateOrFlag(false)).toBeNull();
    expect(normalizeEndoflifeDateOrFlag(" 2027-01-01 ")).toBe("2027-01-01");
  });

  it("maps cycle rows with derived EOL status", () => {
    expect(
      mapEndoflifeRows(
        "nodejs",
        [
          {
            cycle: "22",
            releaseDate: "2024-04-24",
            latest: "22.1.0",
            latestReleaseDate: "2024-05-01",
            lts: true,
            support: "2027-04-30",
            eol: "2027-04-30",
          },
          { cycle: "10", eol: "2021-04-30" },
        ],
        "2026-05-12",
      ),
    ).toMatchObject([
      {
        product: "nodejs",
        cycle: "22",
        lts: "ongoing",
        eolStatus: "active",
        url: "https://endoflife.date/nodejs",
      },
      { cycle: "10", eolStatus: "eol" },
    ]);
  });
});
