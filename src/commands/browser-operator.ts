import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname as pathDirname, join } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import {
  FINGERPRINT_PERSIST_JS,
  verifyRef,
} from "../browser/snapshot-identity.js";
import { rankCandidates, type SnapshotRef } from "../browser/observe.js";
import {
  buildExtractJs,
  buildFindJs,
  ensureNetworkCapture,
  getOperatorPage,
  operatorAction,
  readFrames,
  resolveAllowedUploadPath,
  resolveWorkspace,
  validateRef,
  withBrowserOperatorEnv,
} from "./browser-operator-runtime.js";
import { sendCommand } from "../browser/daemon-client.js";
import { registerBrowserAuthoringSubcommands } from "./browser-authoring-operator.js";

export { withBrowserOperatorEnv };

export function applyBrowserOperatorRootOptions(command: Command): void {
  command
    .option(
      "--workspace <name>",
      "Reuse a named automation workspace instead of the default shared session",
    )
    .option(
      "--isolated",
      "Use a unique per-command workspace to avoid cross-command interference",
    )
    .option("--shared-session", "Force the default shared browser workspace")
    .option(
      "--daemon-port <port>",
      "Route through a specific daemon port for multi-profile setups",
    )
    .option("--focus", "Allow the automation window to take focus")
    .option(
      "--background",
      "Prefer background operation and avoid focus-stealing where possible",
    );
}

export function registerBrowserOperatorSubcommands(
  root: Command,
  program: Command,
  namespace: "browser" | "operate",
): void {
  root
    .command("open <url>")
    .description("Navigate to URL in daemon browser")
    .action((url: string) =>
      operatorAction(program, root, namespace, "open", async () => {
        const page = await getOperatorPage(root, namespace);
        await ensureNetworkCapture(page);
        await page.goto(url, { settleMs: 2000 });
        const title = await page.title();
        return {
          ok: true,
          url,
          title,
          workspace: resolveWorkspace(root, namespace),
        };
      }),
    );

  root
    .command("back")
    .description("Navigate back in history")
    .action(() =>
      operatorAction(program, root, namespace, "back", async () => {
        const page = await getOperatorPage(root, namespace);
        await page.evaluate("history.back()");
        await page.wait(2);
        return { ok: true, url: await page.url() };
      }),
    );

  root
    .command("state")
    .description("Get DOM accessibility tree snapshot")
    .option("--interactive", "only show interactive elements")
    .option("--compact", "omit decorative nodes")
    .action((opts: { interactive?: boolean; compact?: boolean }) =>
      operatorAction(program, root, namespace, "state", async () => {
        const page = await getOperatorPage(root, namespace);
        const url = await page.url();
        const snapshot = await page.snapshot({
          interactive: opts.interactive,
          compact: opts.compact,
        });
        console.error(chalk.dim(`URL: ${url}`));
        return { url, snapshot };
      }),
    );

  root
    .command("screenshot [path]")
    .description("Capture page screenshot")
    .option("--full-page", "capture full scrollable page")
    .action((path: string | undefined, opts: { fullPage?: boolean }) =>
      operatorAction(program, root, namespace, "screenshot", async () => {
        const page = await getOperatorPage(root, namespace);
        const buf = await page.screenshot({
          fullPage: opts.fullPage,
          path: path ?? undefined,
        });
        if (path) {
          return { ok: true, path, size: buf.length };
        }
        return buf.toString("base64");
      }),
    );

  root
    .command("click <ref>")
    .description("Click element by ref number from state")
    .action((ref: string) =>
      operatorAction(program, root, namespace, "click", async () => {
        validateRef(ref);
        const page = await getOperatorPage(root, namespace);
        const selector = `[data-unicli-ref="${ref}"]`;
        await verifyRef(page, selector);
        await page.click(selector);
        return { ok: true, clicked: ref };
      }),
    );

  root
    .command("type <ref> <text>")
    .description("Type text into element by ref number")
    .action((ref: string, text: string) =>
      operatorAction(program, root, namespace, "type", async () => {
        validateRef(ref);
        const page = await getOperatorPage(root, namespace);
        const selector = `[data-unicli-ref="${ref}"]`;
        await verifyRef(page, selector);
        await page.click(selector);
        await page.wait(0.3);
        await page.insertText(text);
        return { ok: true, ref, text };
      }),
    );

  root
    .command("keys <key>")
    .description("Press keyboard key (e.g., Enter, Escape, Control+a)")
    .action((key: string) =>
      operatorAction(program, root, namespace, "keys", async () => {
        const page = await getOperatorPage(root, namespace);
        if (key.includes("+")) {
          const parts = key.split("+");
          const actualKey = parts.pop()!;
          await page.press(
            actualKey,
            parts.map((modifier) => modifier.toLowerCase()),
          );
        } else {
          await page.press(key);
        }
        return { ok: true, key };
      }),
    );

  root
    .command("scroll [direction]")
    .description("Scroll page (down, up, bottom, top)")
    .option("--auto", "auto-scroll to bottom")
    .option("--max <n>", "max scroll iterations for auto", "10")
    .action(
      (direction: string | undefined, opts: { auto?: boolean; max: string }) =>
        operatorAction(program, root, namespace, "scroll", async () => {
          const page = await getOperatorPage(root, namespace);
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

  const get = root
    .command("get")
    .description("Get page data (title, url, text, value, html, attributes)");

  get
    .command("title")
    .description("Get page title")
    .action(() =>
      operatorAction(program, root, namespace, "get title", async () => {
        const page = await getOperatorPage(root, namespace);
        return await page.title();
      }),
    );

  get
    .command("url")
    .description("Get current URL")
    .action(() =>
      operatorAction(program, root, namespace, "get url", async () => {
        const page = await getOperatorPage(root, namespace);
        return await page.url();
      }),
    );

  get
    .command("text <ref>")
    .description("Get text content of element by ref")
    .action((ref: string) =>
      operatorAction(program, root, namespace, "get text", async () => {
        validateRef(ref);
        const page = await getOperatorPage(root, namespace);
        return await page.evaluate(
          `document.querySelector('[data-unicli-ref="${ref}"]')?.textContent?.trim() ?? null`,
        );
      }),
    );

  get
    .command("value <ref>")
    .description("Get value of input element by ref")
    .action((ref: string) =>
      operatorAction(program, root, namespace, "get value", async () => {
        validateRef(ref);
        const page = await getOperatorPage(root, namespace);
        return await page.evaluate(
          `document.querySelector('[data-unicli-ref="${ref}"]')?.value ?? null`,
        );
      }),
    );

  get
    .command("html [selector]")
    .description("Get outerHTML of element (or full page)")
    .action((selector: string | undefined) =>
      operatorAction(program, root, namespace, "get html", async () => {
        const page = await getOperatorPage(root, namespace);
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
      operatorAction(program, root, namespace, "get attributes", async () => {
        validateRef(ref);
        const page = await getOperatorPage(root, namespace);
        return await page.evaluate(
          `(() => { const el = document.querySelector('[data-unicli-ref="${ref}"]'); if (!el) return null; const attrs = {}; for (const a of el.attributes) attrs[a.name] = a.value; return attrs; })()`,
        );
      }),
    );

  root
    .command("wait <type> [value]")
    .description("Wait for condition (time <ms>, selector <sel>, text <str>)")
    .option("--timeout <ms>", "timeout in ms", "10000")
    .action(
      (type: string, value: string | undefined, opts: { timeout: string }) =>
        operatorAction(program, root, namespace, "wait", async () => {
          const page = await getOperatorPage(root, namespace);
          const timeout = parseInt(opts.timeout, 10);
          switch (type) {
            case "time":
              await page.wait(parseInt(value ?? "1000", 10) / 1000);
              break;
            case "selector":
              if (!value) throw new Error("selector value required");
              await page.waitForSelector(value, timeout);
              break;
            case "text": {
              if (!value) throw new Error("text value required");
              const deadline = Date.now() + timeout;
              const valueStr = JSON.stringify(value);
              while (Date.now() < deadline) {
                const found = await page.evaluate(
                  `document.body.innerText.includes(${valueStr})`,
                );
                if (found) return { ok: true, found: true };
                await new Promise((resolve) => setTimeout(resolve, 200));
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

  root
    .command("eval <js>")
    .description("Execute JavaScript in page context")
    .action((js: string) =>
      operatorAction(program, root, namespace, "eval", async () => {
        const page = await getOperatorPage(root, namespace);
        return await page.evaluate(js);
      }),
    );

  registerBrowserAuthoringSubcommands(root, program, namespace);

  root
    .command("select <ref> <option>")
    .description("Select option in dropdown by ref")
    .action((ref: string, option: string) =>
      operatorAction(program, root, namespace, "select", async () => {
        validateRef(ref);
        const page = await getOperatorPage(root, namespace);
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

  root
    .command("upload <ref> <path>")
    .description("Upload file to file input element by ref number")
    .action((ref: string, filePath: string) =>
      operatorAction(program, root, namespace, "upload", async () => {
        validateRef(ref);
        const selector = `[data-unicli-ref="${ref}"]`;
        const absolutePath = resolveAllowedUploadPath(filePath);
        const page = await getOperatorPage(root, namespace);
        await page.setFileInput(selector, [absolutePath]);
        return { ok: true, ref, path: absolutePath };
      }),
    );

  root
    .command("hover <ref>")
    .description("Hover over element by ref number")
    .action((ref: string) =>
      operatorAction(program, root, namespace, "hover", async () => {
        validateRef(ref);
        const selector = `[data-unicli-ref="${ref}"]`;
        const selectorJson = JSON.stringify(selector);
        const page = await getOperatorPage(root, namespace);
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

  root
    .command("observe <query>")
    .description("Preview ranked candidate actions for a natural-language goal")
    .option("--top-k <n>", "Number of candidates to return", "5")
    .option(
      "--cache <path>",
      "Cache file (default ~/.unicli/observe-cache.jsonl)",
    )
    .action((query: string, opts: { topK?: string; cache?: string }) =>
      operatorAction(program, root, namespace, "observe", async () => {
        const page = await getOperatorPage(root, namespace);
        const rawSnapshot = await page.snapshot({
          interactive: true,
          raw: true,
        });
        let parsed: { refs?: SnapshotRef[] } = { refs: [] };
        if (typeof rawSnapshot === "string") {
          try {
            parsed = JSON.parse(rawSnapshot) as { refs?: SnapshotRef[] };
          } catch {
            // Ignore malformed raw snapshot payloads.
          }
        } else {
          parsed = rawSnapshot as { refs?: SnapshotRef[] };
        }
        const refs = Array.isArray(parsed.refs) ? parsed.refs : [];
        const topK = parseInt(opts.topK ?? "5", 10) || 5;
        const candidates = rankCandidates(refs, query, topK);

        const cachePath =
          opts.cache ?? join(homedir(), ".unicli", "observe-cache.jsonl");
        try {
          mkdirSync(pathDirname(cachePath), { recursive: true });
          appendFileSync(
            cachePath,
            JSON.stringify({
              ts: new Date().toISOString(),
              url: await page.url(),
              query,
              candidates,
            }) + "\n",
            "utf-8",
          );
        } catch {
          // Cache failures are non-fatal.
        }

        return { query, candidates };
      }),
    );

  root
    .command("find")
    .description("Find elements by CSS selector and allocate refs on demand")
    .requiredOption("--css <selector>", "CSS selector to query")
    .option("--limit <n>", "Maximum matches to return", "20")
    .option("--text-max <n>", "Maximum text length per row", "120")
    .action((opts: { css: string; limit: string; textMax: string }) =>
      operatorAction(program, root, namespace, "find", async () => {
        const page = await getOperatorPage(root, namespace);
        const results = (await page.evaluate(
          buildFindJs(
            opts.css,
            parseInt(opts.limit, 10) || 20,
            parseInt(opts.textMax, 10) || 120,
          ),
        )) as Array<Record<string, unknown>>;
        try {
          await page.evaluate(FINGERPRINT_PERSIST_JS);
        } catch {
          // Best-effort only.
        }
        return results;
      }),
    );

  root
    .command("frames")
    .description("List iframe frame tree entries for the current page")
    .action(() =>
      operatorAction(program, root, namespace, "frames", async () => {
        const page = await getOperatorPage(root, namespace);
        return await readFrames(page);
      }),
    );

  root
    .command("extract")
    .description("Extract long-form page text with chunked pagination")
    .option("--selector <css>", "Optional content root selector")
    .option("--chunk-size <n>", "Maximum chars to return", "8000")
    .option("--start <n>", "Start offset", "0")
    .action((opts: { selector?: string; chunkSize: string; start: string }) =>
      operatorAction(program, root, namespace, "extract", async () => {
        const page = await getOperatorPage(root, namespace);
        const result = (await page.evaluate(buildExtractJs(opts.selector))) as {
          selector: string;
          title: string;
          url: string;
          content: string;
        };
        const start = Math.max(0, parseInt(opts.start, 10) || 0);
        const chunkSize = Math.max(256, parseInt(opts.chunkSize, 10) || 8000);
        const end = Math.min(result.content.length, start + chunkSize);
        return {
          url: result.url,
          title: result.title,
          selector: result.selector,
          total_chars: result.content.length,
          chunk_size: chunkSize,
          start,
          end,
          next_start_char: end < result.content.length ? end : null,
          content: result.content.slice(start, end),
        };
      }),
    );

  root
    .command("tabs")
    .description("List tabs for the current browser workspace")
    .action(() =>
      operatorAction(program, root, namespace, "tabs", async () => {
        const workspace = resolveWorkspace(root, namespace);
        const result = await sendCommand("tabs", { workspace });
        return Array.isArray(result) ? result : [];
      }),
    );

  root
    .command("close")
    .description("Close the automation browser window")
    .action(() =>
      operatorAction(program, root, namespace, "close", async () => {
        const page = await getOperatorPage(root, namespace);
        await page.closeWindow();
        return { ok: true, workspace: resolveWorkspace(root, namespace) };
      }),
    );
}
