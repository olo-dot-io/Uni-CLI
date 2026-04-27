// Runs inside each Vitest worker. Keep child-process tests deterministic by
// sanitizing environment before test code spawns `npx`, `npm`, or Uni-CLI.
process.env.UNICLI_ALLOW_LOCAL = process.env.UNICLI_ALLOW_LOCAL ?? "1";

for (const key of Object.keys(process.env)) {
  if (/^(npm|pnpm)_config_/i.test(key)) delete process.env[key];
}
