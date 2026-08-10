import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UPDATE_REMIND_LATER_MS,
  clearUpdatePreferences,
  deferUpdate,
  dismissUpdate,
  readUpdatePreferences,
  setAutomaticUpdates,
  updateSuppression,
} from "../../src/engine/update-preferences.js";

let root = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unicli-update-preferences-"));
  env = {
    ...process.env,
    UNICLI_UPDATE_PREFERENCES_PATH: join(root, "state", "preferences.json"),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("update preferences", () => {
  it("defers one exact release for 24 hours in owner-only storage", () => {
    deferUpdate("2.0.0", env, 1_000);
    const preferences = readUpdatePreferences(env);

    expect(preferences).toEqual({
      deferredVersion: "2.0.0",
      deferredUntil: 1_000 + UPDATE_REMIND_LATER_MS,
    });
    expect(updateSuppression("2.0.0", preferences, 2_000)).toBe("deferred");
    expect(
      updateSuppression("2.0.0", preferences, 1_000 + UPDATE_REMIND_LATER_MS),
    ).toBeUndefined();
    if (process.platform !== "win32") {
      expect(lstatSync(join(root, "state")).mode & 0o777).toBe(0o700);
      expect(
        lstatSync(join(root, "state", "preferences.json")).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("dismisses only the selected release and clears old deferrals", () => {
    setAutomaticUpdates(false, env);
    deferUpdate("2.0.0", env, 1_000);
    dismissUpdate("2.0.0", env);
    const preferences = readUpdatePreferences(env);

    expect(preferences).toEqual({
      dismissedVersion: "2.0.0",
      automaticUpdates: false,
    });
    expect(updateSuppression("2.0.0", preferences)).toBe("dismissed");
    expect(updateSuppression("2.0.1", preferences)).toBeUndefined();

    clearUpdatePreferences(env);
    expect(
      JSON.parse(readFileSync(env.UNICLI_UPDATE_PREFERENCES_PATH!, "utf-8")),
    ).toEqual({ automaticUpdates: false });
  });
});
