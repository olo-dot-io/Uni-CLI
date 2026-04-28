// Runs inside each Vitest worker. Keep child-process tests deterministic by
// sanitizing environment before test code spawns `npx`, `npm`, or Uni-CLI.
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const childProcess =
  require("node:child_process") as typeof import("node:child_process");

process.env.UNICLI_ALLOW_LOCAL = process.env.UNICLI_ALLOW_LOCAL ?? "1";

for (const key of Object.keys(process.env)) {
  if (/^(npm|pnpm)_config_/i.test(key)) delete process.env[key];
}

if (process.platform === "win32") {
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = ((...args: Parameters<typeof originalSpawnSync>) => {
    const [command] = args;
    if (
      typeof command !== "string" ||
      !command.toLowerCase().endsWith(".cmd")
    ) {
      return originalSpawnSync(...args);
    }

    if (Array.isArray(args[1])) {
      const [cmd, cmdArgs, options] = args;
      return originalSpawnSync(cmd, cmdArgs, { ...options, shell: true });
    }

    const [cmd, options] = args;
    return originalSpawnSync(cmd, { ...options, shell: true });
  }) as typeof originalSpawnSync;
  syncBuiltinESMExports();
}
