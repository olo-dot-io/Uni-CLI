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

// Suppress the npm update notifier in spawned `npx` children. The unit tests
// in tests/unit/cli/* (and a few elsewhere) parse the child stderr as a single
// JSON envelope, so any trailing `npm notice ...` line corrupts the parse and
// the test fails for a reason that has nothing to do with the code under test.
// We set this AFTER the cleanup loop above because npm reads the option from
// the `npm_config_*` namespace, which the cleanup loop strips for determinism.
// Forcing it back to `false` after the strip keeps the rest of the env sterile
// while disabling only the one feature whose output collides with our protocol.
process.env.npm_config_update_notifier = "false";

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
