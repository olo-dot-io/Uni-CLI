/**
 * Daemon lifecycle commands: status, stop, restart.
 * Note: no "start" — daemon is auto-spawned by BrowserBridge.connect().
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  fetchDaemonStatus,
  requestDaemonShutdown,
} from "../browser/daemon-client.js";
import { BrowserBridge } from "../browser/bridge.js";

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Manage the browser daemon process");

  daemon
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      const status = await fetchDaemonStatus();
      if (!status) {
        console.log(chalk.yellow("Daemon is not running."));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.bold("Daemon Status"));
      console.log(`  PID:        ${status.pid}`);
      console.log(`  Uptime:     ${Math.round(status.uptime)}s`);
      console.log(
        `  Extension:  ${
          status.extensionConnected
            ? chalk.green("connected") +
              (status.extensionVersion ? ` (v${status.extensionVersion})` : "")
            : chalk.red("not connected")
        }`,
      );
      console.log(`  Pending:    ${status.pending} commands`);
      console.log(`  Memory:     ${status.memoryMB} MB`);
      console.log(`  Port:       ${status.port}`);
    });

  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      const running = await fetchDaemonStatus();
      if (!running) {
        console.log("Daemon is not running.");
        return;
      }
      const ok = await requestDaemonShutdown();
      if (ok) {
        console.log(chalk.green("Daemon stopped."));
      } else {
        console.log(chalk.red("Failed to stop daemon."));
        process.exitCode = 1;
      }
    });

  daemon
    .command("restart")
    .description("Restart the daemon")
    .action(async () => {
      // Stop if running
      const status = await fetchDaemonStatus();
      if (status) {
        await requestDaemonShutdown();
        // Wait until stopped (max 5s)
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          const s = await fetchDaemonStatus({ timeout: 500 });
          if (!s) break;
        }
      }
      // Start via BrowserBridge
      const bridge = new BrowserBridge();
      try {
        await bridge.connect({ timeout: 10000 });
        console.log(chalk.green("Daemon restarted."));
      } catch (err) {
        console.log(
          chalk.red(
            `Failed to restart: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
