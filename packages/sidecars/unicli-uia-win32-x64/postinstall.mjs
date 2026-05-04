#!/usr/bin/env node

const platform =
  process.env.UNICLI_SIDECAR_POSTINSTALL_PLATFORM ??
  process.env.UNICLI_SIDEcar_POSTINSTALL_PLATFORM ??
  process.platform;

if (platform !== "win32") process.exit(0);

console.log(
  [
    "Uni-CLI UIA sidecar installed.",
    "Run `unicli doctor compute` to verify UI Automation access and sidecar startup.",
    "Elevated applications may require running Uni-CLI from an elevated terminal.",
  ].join("\n"),
);
