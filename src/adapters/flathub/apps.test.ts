import { describe, expect, it } from "vitest";
import {
  joinFlathubList,
  mapFlathubAppRow,
  mapFlathubSearchRows,
  pickLatestFlathubRelease,
  requireFlathubAppId,
  requireFlathubLimit,
} from "./apps.js";

describe("flathub agent-facing app commands", () => {
  it("validates limits and AppStream ids", () => {
    expect(requireFlathubLimit(undefined)).toBe(25);
    expect(requireFlathubLimit("100")).toBe(100);
    expect(() => requireFlathubLimit("101")).toThrow("flathub limit must");
    expect(requireFlathubAppId("org.mozilla.firefox")).toBe(
      "org.mozilla.firefox",
    );
    expect(() => requireFlathubAppId("firefox")).toThrow("not valid");
  });

  it("joins lists and picks latest releases", () => {
    expect(joinFlathubList(["one", "two"], 1)).toBe("one, (+1)");
    expect(
      pickLatestFlathubRelease([
        { version: "1.0", timestamp: 1 },
        { version: "2.0", timestamp: "2" },
      ]),
    ).toEqual({ date: "1970-01-01", version: "2.0" });
  });

  it("maps search rows", () => {
    expect(
      mapFlathubSearchRows(
        [
          {
            app_id: "org.mozilla.firefox",
            name: "Firefox",
            summary: "Browser",
            developer_name: "Mozilla",
            project_license: "MPL-2.0",
            is_free_license: true,
            main_categories: "Network",
            installs_last_month: "100",
            updated_at: 1,
          },
        ],
        25,
      ),
    ).toMatchObject([
      {
        rank: 1,
        appId: "org.mozilla.firefox",
        name: "Firefox",
        isFreeLicense: true,
        installsLastMonth: 100,
        updatedAt: "1970-01-01",
      },
    ]);
  });

  it("maps app rows", () => {
    expect(
      mapFlathubAppRow("org.mozilla.firefox", {
        id: "org.mozilla.firefox",
        name: "Firefox",
        summary: "Browser",
        developer_name: "Mozilla",
        project_license: "MPL-2.0",
        is_free_license: true,
        is_eol: false,
        categories: ["Network", "WebBrowser"],
        keywords: ["web", "browser"],
        releases: [{ version: "1.0", timestamp: 1 }],
        urls: { homepage: "https://www.mozilla.org" },
      }),
    ).toMatchObject({
      appId: "org.mozilla.firefox",
      categories: "Network, WebBrowser",
      latestVersion: "1.0",
      homepage: "https://www.mozilla.org",
      url: "https://flathub.org/apps/org.mozilla.firefox",
    });
  });
});
