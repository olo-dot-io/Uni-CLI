/**
 * Shared helper for Electron AI chat app adapters.
 * Provides common patterns: send prompt, read response, model switch, etc.
 *
 * Most Electron apps are AI chat interfaces with the same interaction pattern.
 * Each app calls registerAIChatCommands() with app-specific CSS selectors.
 */

import { cli, Strategy } from "../../registry.js";
import {
  resolveElectronEndpoint,
  launchElectronApp,
} from "../../browser/launcher.js";
import { CDPClient } from "../../browser/cdp-client.js";
import { BrowserPage } from "../../browser/page.js";
import { injectStealth } from "../../browser/stealth.js";

/**
 * Connect to an Electron app via CDP.
 * Launches the app if not running.
 */
export async function connectElectronApp(site: string): Promise<BrowserPage> {
  let endpoint = await resolveElectronEndpoint(site);
  if (!endpoint) {
    endpoint = await launchElectronApp(site);
  }
  const client = new CDPClient();
  await client.connect(endpoint.wsUrl);
  const page = new BrowserPage(client);
  await injectStealth(page.sendCDP.bind(page));
  return page;
}

/** Configuration for registerAIChatCommands */
export interface AIChatConfig {
  inputSelector: string;
  responseSelector: string;
  modelSelector?: string;
  historySelector?: string;
  newChatSelector?: string;
  sendMethod?: "enter" | "button";
  sendButtonSelector?: string;
  displayName?: string;
}

/**
 * Register standard AI chat commands for an Electron app.
 * Each app gets: ask, send, read, model, status, new, screenshot, dump
 */
export function registerAIChatCommands(
  site: string,
  config: AIChatConfig,
): void {
  const {
    inputSelector,
    responseSelector,
    modelSelector,
    newChatSelector,
    sendMethod = "enter",
    sendButtonSelector,
    displayName = site,
  } = config;

  /** Escape single quotes in selectors for use in evaluate strings */
  const esc = (s: string): string => s.replace(/'/g, "\\'");

  // ask <prompt> -- Send and wait for response
  cli({
    site,
    name: "ask",
    description: `Send a prompt to ${displayName} and wait for response`,
    strategy: Strategy.PUBLIC,
    args: [
      {
        name: "prompt",
        required: true,
        positional: true,
        description: "The prompt to send",
      },
    ],
    func: async (_page: unknown, kwargs: Record<string, unknown>) => {
      const p = await connectElectronApp(site);
      const prompt = String(kwargs.prompt);
      await p.click(inputSelector);
      await p.wait(0.3);
      await p.insertText(prompt);
      if (sendMethod === "button" && sendButtonSelector) {
        await p.click(sendButtonSelector);
      } else {
        await p.press("Enter");
      }
      // Wait for response to stabilize (poll for content change)
      await p.wait(2);
      const maxWait = 60;
      const start = Date.now();
      let lastText = "";
      while ((Date.now() - start) / 1000 < maxWait) {
        await p.wait(1);
        const text = (await p.evaluate(
          `document.querySelector('${esc(responseSelector)}')?.innerText ?? ''`,
        )) as string;
        if (text && text === lastText && text.length > 0) {
          return [{ response: text }];
        }
        lastText = text;
      }
      return [{ response: lastText || "(no response)" }];
    },
  });

  // send <text> -- Send without waiting
  cli({
    site,
    name: "send",
    description: `Send text to ${displayName} without waiting`,
    strategy: Strategy.PUBLIC,
    args: [{ name: "text", required: true, positional: true }],
    func: async (_page: unknown, kwargs: Record<string, unknown>) => {
      const p = await connectElectronApp(site);
      await p.click(inputSelector);
      await p.wait(0.3);
      await p.insertText(String(kwargs.text));
      if (sendMethod === "button" && sendButtonSelector) {
        await p.click(sendButtonSelector);
      } else {
        await p.press("Enter");
      }
      return [{ ok: true }];
    },
  });

  // read -- Read last response
  cli({
    site,
    name: "read",
    description: `Read the last response from ${displayName}`,
    strategy: Strategy.PUBLIC,
    func: async () => {
      const p = await connectElectronApp(site);
      const text = (await p.evaluate(
        `document.querySelector('${esc(responseSelector)}')?.innerText ?? ''`,
      )) as string;
      return [{ response: text }];
    },
  });

  // model [name] -- Read or switch model
  if (modelSelector) {
    cli({
      site,
      name: "model",
      description: `Read or switch the current model in ${displayName}`,
      strategy: Strategy.PUBLIC,
      args: [{ name: "name", required: false, positional: true }],
      func: async (_page: unknown, _kwargs: Record<string, unknown>) => {
        const p = await connectElectronApp(site);
        const current = (await p.evaluate(
          `document.querySelector('${esc(modelSelector)}')?.innerText ?? 'unknown'`,
        )) as string;
        return [{ model: current }];
      },
    });
  }

  // status -- App status
  cli({
    site,
    name: "status",
    description: `Check ${displayName} app status`,
    strategy: Strategy.PUBLIC,
    func: async () => {
      const p = await connectElectronApp(site);
      const title = await p.title();
      const url = await p.url();
      const model = modelSelector
        ? ((await p.evaluate(
            `document.querySelector('${esc(modelSelector)}')?.innerText ?? 'unknown'`,
          )) as string)
        : "N/A";
      return [{ app: displayName, title, url, model }];
    },
  });

  // new -- New conversation
  if (newChatSelector) {
    cli({
      site,
      name: "new",
      description: `Start a new conversation in ${displayName}`,
      strategy: Strategy.PUBLIC,
      func: async () => {
        const p = await connectElectronApp(site);
        if (newChatSelector.startsWith("key:")) {
          const combo = newChatSelector.slice(4);
          const parts = combo.split("+");
          const key = parts.pop()!;
          await p.press(
            key,
            parts.map((m) => m.toLowerCase()),
          );
        } else {
          await p.click(newChatSelector);
        }
        await p.wait(1);
        return [{ ok: true }];
      },
    });
  }

  // screenshot -- Capture current view
  cli({
    site,
    name: "screenshot",
    description: `Capture screenshot of ${displayName}`,
    strategy: Strategy.PUBLIC,
    args: [
      {
        name: "path",
        required: false,
        positional: true,
        default: `./${site}-screenshot.png`,
      },
    ],
    func: async (_page: unknown, kwargs: Record<string, unknown>) => {
      const p = await connectElectronApp(site);
      const filePath = String(kwargs.path ?? `./${site}-screenshot.png`);
      const buf = await p.screenshot({ path: filePath, format: "png" });
      return [{ path: filePath, size: buf.length }];
    },
  });

  // dump -- Full page content as JSON
  cli({
    site,
    name: "dump",
    description: `Dump full page content from ${displayName}`,
    strategy: Strategy.PUBLIC,
    func: async () => {
      const p = await connectElectronApp(site);
      const snapshot = await p.snapshot({ compact: true });
      return [{ snapshot }];
    },
  });
}
