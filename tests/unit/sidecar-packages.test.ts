import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

function readPackage(relativeDir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(ROOT, relativeDir, "package.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("sidecar platform packages", () => {
  it("all sidecar packages expose a postinstall helper", () => {
    for (const dir of [
      "packages/sidecars/unicli-atspi-linux-x64",
      "packages/sidecars/unicli-atspi-linux-arm64",
      "packages/sidecars/unicli-uia-win32-x64",
      "packages/sidecars/unicli-uia-win32-arm64",
    ]) {
      const pkg = readPackage(dir);
      const scripts = pkg.scripts as Record<string, unknown> | undefined;
      const files = pkg.files as unknown[] | undefined;

      expect(scripts?.postinstall).toBe("node postinstall.mjs");
      expect(files).toContain("postinstall.mjs");
      expect(existsSync(join(ROOT, dir, "postinstall.mjs"))).toBe(true);
    }
  });

  it("linux AT-SPI packages ship a postinstall helper for display input hints", () => {
    for (const dir of [
      "packages/sidecars/unicli-atspi-linux-x64",
      "packages/sidecars/unicli-atspi-linux-arm64",
    ]) {
      const pkg = readPackage(dir);
      const scripts = pkg.scripts as Record<string, unknown> | undefined;
      const files = pkg.files as unknown[] | undefined;

      expect(scripts?.postinstall).toBe("node postinstall.mjs");
      expect(files).toContain("postinstall.mjs");
      expect(existsSync(join(ROOT, dir, "postinstall.mjs"))).toBe(true);
    }
  });

  it("AT-SPI postinstall warns about missing Linux input helpers", () => {
    const output = execFileSync(
      process.execPath,
      ["packages/sidecars/unicli-atspi-linux-x64/postinstall.mjs"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          UNICLI_SIDEcar_POSTINSTALL_PLATFORM: "linux",
          WAYLAND_DISPLAY: "wayland-1",
          PATH: "",
        },
        encoding: "utf8",
      },
    );

    expect(output).toContain("ydotool");
    expect(output).toContain("wtype");
  });

  it("UIA postinstall points Windows users to compute doctor", () => {
    const output = execFileSync(
      process.execPath,
      ["packages/sidecars/unicli-uia-win32-x64/postinstall.mjs"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          UNICLI_SIDECAR_POSTINSTALL_PLATFORM: "win32",
        },
        encoding: "utf8",
      },
    );

    expect(output).toContain("Uni-CLI UIA sidecar installed");
    expect(output).toContain("unicli doctor compute");
  });
});
