import { describe, expect, it } from "vitest";
import {
  packageNameForSidecar,
  resolveSidecarBinary,
} from "../../../src/transport/sidecar-binary.js";

describe("sidecar binary resolution", () => {
  it("maps sidecar package names by host platform and arch", () => {
    expect(packageNameForSidecar("unicli-uia", "win32", "x64")).toBe(
      "@zenalexa/unicli-uia-win32-x64",
    );
    expect(packageNameForSidecar("unicli-uia", "win32", "arm64")).toBe(
      "@zenalexa/unicli-uia-win32-arm64",
    );
    expect(packageNameForSidecar("unicli-atspi", "linux", "x64")).toBe(
      "@zenalexa/unicli-atspi-linux-x64",
    );
    expect(
      packageNameForSidecar("unicli-atspi", "darwin", "arm64"),
    ).toBeUndefined();
  });

  it("prefers explicit env override", () => {
    const resolved = resolveSidecarBinary("unicli-uia", {
      platform: "win32",
      arch: "x64",
      env: { UNICLI_UIA_SIDECAR: "C:\\tools\\unicli-uia.exe" },
      exists: () => false,
      requireResolve: () => {
        throw new Error("not found");
      },
      homeDir: "/Users/example",
    });

    expect(resolved).toEqual({
      command: "C:\\tools\\unicli-uia.exe",
      source: "env",
      packageName: "@zenalexa/unicli-uia-win32-x64",
    });
  });

  it("prefers platform package binary before user sidecar dir", () => {
    const resolved = resolveSidecarBinary("unicli-atspi", {
      platform: "linux",
      arch: "arm64",
      env: {},
      exists: (path) => path.endsWith("/package/unicli-atspi"),
      requireResolve: () =>
        "/repo/node_modules/@zenalexa/unicli-atspi-linux-arm64/package.json",
      homeDir: "/home/example",
    });

    expect(resolved).toEqual({
      command:
        "/repo/node_modules/@zenalexa/unicli-atspi-linux-arm64/unicli-atspi",
      source: "package",
      packageName: "@zenalexa/unicli-atspi-linux-arm64",
    });
  });

  it("uses ~/.unicli sidecar before PATH fallback", () => {
    const resolved = resolveSidecarBinary("unicli-atspi", {
      platform: "linux",
      arch: "x64",
      env: {},
      exists: (path) => path === "/home/example/.unicli/sidecars/unicli-atspi",
      requireResolve: () => {
        throw new Error("not found");
      },
      homeDir: "/home/example",
    });

    expect(resolved.source).toBe("user");
    expect(resolved.command).toBe(
      "/home/example/.unicli/sidecars/unicli-atspi",
    );
  });
});
