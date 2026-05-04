#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";

const platform =
  process.env.UNICLI_SIDECAR_POSTINSTALL_PLATFORM ??
  process.env.UNICLI_SIDEcar_POSTINSTALL_PLATFORM ??
  process.platform;

if (platform !== "linux") process.exit(0);

const wayland = Boolean(process.env.WAYLAND_DISPLAY);
const x11 = Boolean(process.env.DISPLAY);
const missing = [];

if (wayland) {
  if (!hasCommand("ydotool")) missing.push("ydotool");
  if (!hasCommand("wtype")) missing.push("wtype");
} else if (x11) {
  if (!hasCommand("xdotool")) missing.push("xdotool");
}

if (missing.length > 0) {
  console.log(
    [
      "Uni-CLI AT-SPI sidecar installed.",
      `Missing optional input helper${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
      "Run `unicli doctor compute` for distro-specific install commands.",
    ].join("\n"),
  );
}

function hasCommand(command) {
  const path = process.env.PATH ?? "";
  return path
    .split(":")
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, command)));
}
