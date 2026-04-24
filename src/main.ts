#!/usr/bin/env node

/**
 * unicli — The universal interface between AI agents and the world's software.
 */

const args = process.argv.slice(2);
const acpFastPath =
  args[0] === "acp" && args.slice(1).every((arg) => arg === "--debug");

if (acpFastPath) {
  const { serveAcp } = await import("./commands/acp.js");
  await serveAcp({ debug: args.includes("--debug") });
} else {
  const { createCli } = await import("./cli.js");
  const program = await createCli();
  program.parse(process.argv);
}
