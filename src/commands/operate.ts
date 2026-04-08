/**
 * Interactive browser control — `unicli operate` command family.
 *
 * Enables AI agents to navigate, interact with, and inspect web pages
 * through the browser daemon. Each subcommand maps to a daemon action.
 */

import { Command } from "commander";
import { resolve } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { BrowserBridge, DaemonPage } from "../browser/bridge.js";
import { generateReadInterceptedJs } from "../engine/interceptor.js";
import {
  isSensitivePathRealpath,
  buildSensitivePathDenial,
} from "../permissions/sensitive-paths.js";
import { ExitCode } from "../types.js";
import { rankCandidates, type SnapshotRef } from "../browser/observe.js";
import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname as pathDirname } from "node:path";

const OPERATE_WORKSPACE = "operate:default";

/** Validate ref is numeric (from DOM snapshot) to prevent JS injection. */
function validateRef(ref: string): string {
  if (!/^\d+$/.test(ref)) {
    throw new Error(
      `Invalid ref "${ref}". Expected a number from the state output.`,
    );
  }
  return ref;
}

async function getOperatePage(): Promise<DaemonPage> {
  const bridge = new BrowserBridge();
  const page = await bridge.connect({
    timeout: 30_000,
    workspace: OPERATE_WORKSPACE,
  });
  return page as DaemonPage;
}

/** Wrap operate actions for consistent error handling */
async function operateAction(
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await fn();
    if (result !== undefined && result !== null) {
      if (typeof result === "string") {
        console.log(result);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    }
  } catch (err) {
    console.error(
      chalk.red(
        `operate ${name}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exitCode = 1;
  }
}

export function registerOperateCommands(program: Command): void {
  const operate = program
    .command("operate")
    .description("Interactive browser control for agents");

  // open <url> — Navigate to URL
  operate
    .command("open <url>")
    .description("Navigate to URL in daemon browser")
    .action((url: string) =>
      operateAction("open", async () => {
        const page = await getOperatePage();
        // Start CDP-level network capture before navigation so initial
        // requests are not missed. Only available on BrowserPage (not DaemonPage).
        const pageAnyOpen = page as unknown as Record<string, unknown>;
        if (typeof pageAnyOpen.startNetworkCapture === "function") {
          await (
            pageAnyOpen as unknown as { startNetworkCapture(): Promise<void> }
          ).startNetworkCapture();
        }
        await page.goto(url, { settleMs: 2000 });
        const title = await page.title();
        return { ok: true, url, title };
      }),
    );

  // back — Navigate back
  operate
    .command("back")
    .description("Navigate back in history")
    .action(() =>
      operateAction("back", async () => {
        const page = await getOperatePage();
        await page.evaluate("history.back()");
        await page.wait(2);
        const url = await page.url();
        return { ok: true, url };
      }),
    );

  // state — DOM snapshot
  operate
    .command("state")
    .description("Get DOM accessibility tree snapshot")
    .option("--interactive", "only show interactive elements")
    .option("--compact", "omit decorative nodes")
    .action((opts: { interactive?: boolean; compact?: boolean }) =>
      operateAction("state", async () => {
        const page = await getOperatePage();
        const url = await page.url();
        const snapshot = await page.snapshot({
          interactive: opts.interactive,
          compact: opts.compact,
        });
        console.log(chalk.dim(`URL: ${url}`));
        return snapshot;
      }),
    );

  // screenshot [path] — Capture screenshot
  operate
    .command("screenshot [path]")
    .description("Capture page screenshot")
    .option("--full-page", "capture full scrollable page")
    .action((path: string | undefined, opts: { fullPage?: boolean }) =>
      operateAction("screenshot", async () => {
        const page = await getOperatePage();
        const buf = await page.screenshot({
          fullPage: opts.fullPage,
          path: path ?? undefined,
        });
        if (path) {
          return { ok: true, path, size: buf.length };
        }
        // Output base64 to stdout for agent consumption
        return buf.toString("base64");
      }),
    );

  // click <ref> — Click element by ref number
  operate
    .command("click <ref>")
    .description("Click element by ref number from state")
    .action((ref: string) =>
      operateAction("click", async () => {
        validateRef(ref);
        const page = await getOperatePage();
        await page.click(`[data-unicli-ref="${ref}"]`);
        return { ok: true, clicked: ref };
      }),
    );

  // type <ref> <text> — Type into element
  operate
    .command("type <ref> <text>")
    .description("Type text into element by ref number")
    .action((ref: string, text: string) =>
      operateAction("type", async () => {
        validateRef(ref);
        const page = await getOperatePage();
        await page.click(`[data-unicli-ref="${ref}"]`);
        await page.wait(0.3);
        await page.insertText(text);
        return { ok: true, ref, text };
      }),
    );

  // keys <key> — Press keyboard keys
  operate
    .command("keys <key>")
    .description("Press keyboard key (e.g., Enter, Escape, Control+a)")
    .action((key: string) =>
      operateAction("keys", async () => {
        const page = await getOperatePage();
        // Support combo keys: "Control+a" → press with modifiers
        if (key.includes("+")) {
          const parts = key.split("+");
          const actualKey = parts.pop()!;
          const modifiers = parts.map((m) => m.toLowerCase());
          await page.press(actualKey, modifiers);
        } else {
          await page.press(key);
        }
        return { ok: true, key };
      }),
    );

  // scroll [direction] — Scroll page
  operate
    .command("scroll [direction]")
    .description("Scroll page (down, up, bottom, top)")
    .option("--auto", "auto-scroll to bottom")
    .option("--max <n>", "max scroll iterations for auto", "10")
    .action(
      (direction: string | undefined, opts: { auto?: boolean; max: string }) =>
        operateAction("scroll", async () => {
          const page = await getOperatePage();
          if (opts.auto) {
            await page.autoScroll({
              maxScrolls: parseInt(opts.max, 10),
              delay: 1000,
            });
          } else {
            await page.scroll(
              (direction ?? "down") as "down" | "up" | "bottom" | "top",
            );
          }
          return { ok: true, direction: direction ?? "down" };
        }),
    );

  // get <what> [ref] — Get page data
  const get = operate
    .command("get")
    .description("Get page data (title, url, text, value, html, attributes)");

  get
    .command("title")
    .description("Get page title")
    .action(() =>
      operateAction("get title", async () => {
        const page = await getOperatePage();
        return await page.title();
      }),
    );

  get
    .command("url")
    .description("Get current URL")
    .action(() =>
      operateAction("get url", async () => {
        const page = await getOperatePage();
        return await page.url();
      }),
    );

  get
    .command("text <ref>")
    .description("Get text content of element by ref")
    .action((ref: string) =>
      operateAction("get text", async () => {
        validateRef(ref);
        const page = await getOperatePage();
        return await page.evaluate(
          `document.querySelector('[data-unicli-ref="${ref}"]')?.textContent?.trim() ?? null`,
        );
      }),
    );

  get
    .command("value <ref>")
    .description("Get value of input element by ref")
    .action((ref: string) =>
      operateAction("get value", async () => {
        validateRef(ref);
        const page = await getOperatePage();
        return await page.evaluate(
          `document.querySelector('[data-unicli-ref="${ref}"]')?.value ?? null`,
        );
      }),
    );

  get
    .command("html [selector]")
    .description("Get outerHTML of element (or full page)")
    .action((selector: string | undefined) =>
      operateAction("get html", async () => {
        const page = await getOperatePage();
        if (selector) {
          const selectorStr = JSON.stringify(selector);
          return await page.evaluate(
            `document.querySelector(${selectorStr})?.outerHTML?.slice(0, 50000) ?? null`,
          );
        }
        return await page.evaluate(
          "document.documentElement.outerHTML.slice(0, 50000)",
        );
      }),
    );

  get
    .command("attributes <ref>")
    .description("Get all attributes of element by ref")
    .action((ref: string) =>
      operateAction("get attributes", async () => {
        validateRef(ref);
        const page = await getOperatePage();
        return await page.evaluate(
          `(() => { const el = document.querySelector('[data-unicli-ref="${ref}"]'); if (!el) return null; const attrs = {}; for (const a of el.attributes) attrs[a.name] = a.value; return JSON.stringify(attrs); })()`,
        );
      }),
    );

  // wait <type> [value] — Wait for condition
  operate
    .command("wait <type> [value]")
    .description("Wait for condition (time <ms>, selector <sel>, text <str>)")
    .option("--timeout <ms>", "timeout in ms", "10000")
    .action(
      (type: string, value: string | undefined, opts: { timeout: string }) =>
        operateAction("wait", async () => {
          const page = await getOperatePage();
          const timeout = parseInt(opts.timeout, 10);
          switch (type) {
            case "time":
              await page.wait(parseInt(value ?? "1000", 10) / 1000);
              break;
            case "selector":
              if (!value) throw new Error("selector value required");
              await page.waitForSelector(value, timeout);
              break;
            case "text":
              if (!value) throw new Error("text value required");
              // Poll for text content
              {
                const deadline = Date.now() + timeout;
                const valueStr = JSON.stringify(value);
                while (Date.now() < deadline) {
                  const found = await page.evaluate(
                    `document.body.innerText.includes(${valueStr})`,
                  );
                  if (found) return { ok: true, found: true };
                  await new Promise((r) => setTimeout(r, 200));
                }
                throw new Error(
                  `Text "${value}" not found within ${String(timeout)}ms`,
                );
              }
            default:
              throw new Error(
                `Unknown wait type: ${type}. Use: time, selector, text`,
              );
          }
          return { ok: true };
        }),
    );

  // eval <js> — Execute JavaScript
  operate
    .command("eval <js>")
    .description("Execute JavaScript in page context")
    .action((js: string) =>
      operateAction("eval", async () => {
        const page = await getOperatePage();
        return await page.evaluate(js);
      }),
    );

  // network [pattern] — Show network requests (CDP-first, JS-interceptor fallback)
  operate
    .command("network [pattern]")
    .description("Show captured network requests")
    .option("--all", "show all requests (no filter)")
    .action((pattern: string | undefined, opts: { all?: boolean }) =>
      operateAction("network", async () => {
        const page = await getOperatePage();

        // Normalized entry shape for both CDP and JS-interceptor paths
        interface NormalizedEntry {
          url: string;
          method: string;
          status: number;
          contentType: string;
          bodySize: number;
        }

        let entries: NormalizedEntry[] = [];

        // Path 1: CDP-level capture via readNetworkCapture() (BrowserPage only)
        const pageAny = page as unknown as Record<string, unknown>;
        if (typeof pageAny.readNetworkCapture === "function") {
          const cdpEntries =
            (await (
              pageAny as unknown as {
                readNetworkCapture(): Promise<
                  Array<{
                    url: string;
                    method: string;
                    status: number;
                    contentType: string;
                    size: number;
                  }>
                >;
              }
            ).readNetworkCapture()) ?? [];

          entries = cdpEntries.map((e) => ({
            url: e.url,
            method: e.method,
            status: e.status,
            contentType: e.contentType,
            bodySize: e.size,
          }));
        }

        // Path 2: JS-interceptor fallback when CDP capture is empty
        if (entries.length === 0) {
          try {
            const raw = (await page.evaluate(
              generateReadInterceptedJs(),
            )) as string;
            const jsEntries = JSON.parse(raw) as Array<{
              url: string;
              data?: unknown;
              ts?: number;
            }>;
            entries = jsEntries.map((e) => ({
              url: e.url,
              method: "GET",
              status: 200,
              contentType: "application/json",
              bodySize: e.data != null ? JSON.stringify(e.data).length : 0,
            }));
          } catch {
            // JS interceptor not injected or page navigated — return empty
          }
        }

        // Path 3: networkRequests() metadata (always available as last resort)
        if (entries.length === 0) {
          const requests = await page.networkRequests();
          entries = requests.map((r) => ({
            url: r.url,
            method: r.method,
            status: r.status,
            contentType: r.type,
            bodySize: r.size,
          }));
        }

        if (pattern && !opts.all) {
          return entries.filter((r) => r.url.includes(pattern));
        }
        return entries;
      }),
    );

  // select <ref> <option> — Select dropdown option
  operate
    .command("select <ref> <option>")
    .description("Select option in dropdown by ref")
    .action((ref: string, option: string) =>
      operateAction("select", async () => {
        validateRef(ref);
        const page = await getOperatePage();
        const optionStr = JSON.stringify(option);
        await page.evaluate(
          `(() => {
            const el = document.querySelector('[data-unicli-ref="${ref}"]');
            if (!el || el.tagName !== 'SELECT') throw new Error('Not a <select> element');
            el.value = ${optionStr};
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()`,
        );
        return { ok: true, ref, option };
      }),
    );

  // upload <ref> <path> — Upload file to file input
  operate
    .command("upload <ref> <path>")
    .description("Upload file to file input element by ref number")
    .action((ref: string, filePath: string) =>
      operateAction("upload", async () => {
        validateRef(ref);
        const selector = `[data-unicli-ref="${ref}"]`;
        const absolutePath = resolve(filePath);
        // Sensitive-path deny list runs FIRST, before any workspace check.
        // Cannot be overridden by permission mode (defense against prompt
        // injection that points the agent at credentials, keys, or tokens).
        // Uses the symlink-aware variant so `ln -s ~/.ssh/id_rsa /tmp/x.txt`
        // is still blocked.
        if (isSensitivePathRealpath(absolutePath)) {
          const denial = buildSensitivePathDenial(absolutePath);
          console.error(JSON.stringify(denial));
          process.exit(ExitCode.CONFIG_ERROR);
        }
        const cwd = process.cwd();
        const home = homedir();
        if (!absolutePath.startsWith(cwd) && !absolutePath.startsWith(home)) {
          console.error(
            `Upload blocked: path ${absolutePath} is outside workspace and home directory`,
          );
          process.exit(ExitCode.CONFIG_ERROR);
        }
        const page = await getOperatePage();
        await page.setFileInput(selector, [absolutePath]);
        return { ok: true, ref, path: absolutePath };
      }),
    );

  // hover <ref> — Hover over element
  operate
    .command("hover <ref>")
    .description(
      "Hover over element by ref number to trigger mouseover effects",
    )
    .action((ref: string) =>
      operateAction("hover", async () => {
        validateRef(ref);
        const selector = `[data-unicli-ref="${ref}"]`;
        const selectorJson = JSON.stringify(selector);
        const page = await getOperatePage();
        await page.evaluate(
          `(() => {
            const el = document.querySelector(${selectorJson});
            if (!el) throw new Error('Element not found: ' + ${selectorJson});
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          })()`,
        );
        return { ok: true, ref };
      }),
    );

  // observe <query> — preview ranked candidate actions for a natural-language goal
  operate
    .command("observe <query>")
    .description(
      "Preview ranked candidate actions for a natural-language goal (Stagehand-style)",
    )
    .option("--top-k <n>", "Number of candidates to return", "5")
    .option(
      "--cache <path>",
      "Cache file (default ~/.unicli/observe-cache.jsonl)",
    )
    .action((query: string, opts: { topK?: string; cache?: string }) =>
      operateAction("observe", async () => {
        const page = await getOperatePage();
        // We need refs with tag + text + optional attrs. The existing
        // snapshot generator returns this when raw=true. The runtime
        // returns either an object or a JSON string depending on the page
        // implementation; normalize both.
        const rawSnapshotResult = await page.snapshot({
          interactive: true,
          raw: true,
        });
        let parsed: { tree?: string; refs?: SnapshotRef[] };
        if (typeof rawSnapshotResult === "string") {
          try {
            parsed = JSON.parse(rawSnapshotResult) as {
              tree?: string;
              refs?: SnapshotRef[];
            };
          } catch {
            parsed = { refs: [] };
          }
        } else {
          parsed = rawSnapshotResult as { tree?: string; refs?: SnapshotRef[] };
        }
        const refs: SnapshotRef[] = Array.isArray(parsed.refs)
          ? parsed.refs
          : [];
        const topK = parseInt(opts.topK ?? "5", 10) || 5;
        const candidates = rankCandidates(refs, query, topK);

        // Append to cache for self-healing audits
        const cachePath =
          opts.cache ?? join(homedir(), ".unicli", "observe-cache.jsonl");
        try {
          mkdirSync(pathDirname(cachePath), { recursive: true });
          const url = await page.url();
          appendFileSync(
            cachePath,
            JSON.stringify({
              ts: new Date().toISOString(),
              url,
              query,
              candidates,
            }) + "\n",
            "utf-8",
          );
        } catch {
          // Cache write failure is non-fatal — observability infra.
        }

        return { query, candidates };
      }),
    );

  // close — Close automation window
  operate
    .command("close")
    .description("Close the automation browser window")
    .action(() =>
      operateAction("close", async () => {
        const page = await getOperatePage();
        await page.closeWindow();
        return { ok: true };
      }),
    );
}
