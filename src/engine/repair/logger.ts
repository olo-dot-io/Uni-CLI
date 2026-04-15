/**
 * RepairLogger — TSV file logger for self-repair loop iterations.
 * Logs to ~/.unicli/repair/<site>/log.tsv
 */

import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the base directory for the repair log. Honours `$HOME` when set
 * (so tests and CI fixtures can redirect it to a temp dir with a single
 * env override) and falls back to the OS user home. Necessary on Windows,
 * where `os.homedir()` reads `USERPROFILE` by default — tests that set
 * `HOME` alone would otherwise diverge from production.
 */
function repairBaseDir(): string {
  return process.env.HOME || homedir();
}

export interface LogEntry {
  iteration: number;
  metric: number;
  status: "keep" | "discard" | "error";
  delta: number;
  summary: string;
  timestamp: string;
}

const TSV_HEADER = "iteration\tmetric\tstatus\tdelta\tsummary\ttimestamp";

export class RepairLogger {
  private readonly filePath: string;

  constructor(site: string) {
    const dir = join(repairBaseDir(), ".unicli", "repair", site);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.filePath = join(dir, "log.tsv");
    if (!existsSync(this.filePath)) {
      appendFileSync(this.filePath, TSV_HEADER + "\n", "utf-8");
    }
  }

  append(entry: LogEntry): void {
    const line = [
      entry.iteration,
      entry.metric,
      entry.status,
      entry.delta,
      entry.summary.replace(/\t/g, " ").replace(/\n/g, " "),
      entry.timestamp,
    ].join("\t");
    appendFileSync(this.filePath, line + "\n", "utf-8");
  }

  readAll(): LogEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8");
    const lines = content.trim().split("\n").slice(1); // skip header
    return lines
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [iteration, metric, status, delta, summary, timestamp] =
          line.split("\t");
        return {
          iteration: Number(iteration),
          metric: Number(metric),
          status: status as LogEntry["status"],
          delta: Number(delta),
          summary: summary ?? "",
          timestamp: timestamp ?? "",
        };
      });
  }

  readLast(n: number): LogEntry[] {
    const all = this.readAll();
    return all.slice(-n);
  }

  consecutiveDiscards(): number {
    const all = this.readAll();
    let count = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].status === "discard") {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
}
