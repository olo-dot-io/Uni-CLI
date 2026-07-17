import {
  installChromeNativeHost,
  type ChromeNativeHostRegistry,
} from "../../src/browser/native-host-install.js";

class MemoryRegistry implements ChromeNativeHostRegistry {
  private readonly values = new Map<string, string>();

  read(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  write(key: string, manifestPath: string): void {
    this.values.set(key, manifestPath);
  }

  remove(key: string): void {
    this.values.delete(key);
  }
}

const [homeDir, launcherSourcePath, nodePath, entrypointPath] =
  process.argv.slice(2);
if (!homeDir || !launcherSourcePath || !nodePath || !entrypointPath) {
  throw new Error(
    "expected home, launcher source, Node runtime, and native-host entrypoint paths",
  );
}

const [status] = installChromeNativeHost({
  platform: "win32",
  homeDir,
  runtime: {
    kind: "windows",
    launcherSourcePath,
    nodePath,
    entrypointPath,
  },
  browsers: ["chrome"],
  registry: new MemoryRegistry(),
});
process.stdout.write(JSON.stringify(status));
