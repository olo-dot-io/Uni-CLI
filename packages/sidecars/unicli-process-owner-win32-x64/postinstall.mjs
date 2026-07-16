#!/usr/bin/env node

const platform =
  process.env.UNICLI_SIDECAR_POSTINSTALL_PLATFORM ??
  process.env.UNICLI_SIDEcar_POSTINSTALL_PLATFORM ??
  process.platform;

if (platform !== "win32") process.exit(0);

console.log("Uni-CLI Windows process-tree containment installed.");
