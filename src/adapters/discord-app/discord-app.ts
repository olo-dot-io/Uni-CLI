/**
 * Discord desktop app adapter -- server/channel navigation + messaging.
 *
 * Commands: servers, channels, read, send, search, members, status
 */

import { connectElectronApp } from "../_electron/shared.js";
import { cli, Strategy } from "../../registry.js";

// servers -- List Discord servers
cli({
  site: "discord-app",
  name: "servers",
  description: "List Discord servers",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("discord-app");
    const servers = await p.evaluate(`
      (() => {
        const items = document.querySelectorAll(
          '[data-list-id="guildsnav"] [class*="listItem"]'
        );
        return Array.from(items).map(el => ({
          name: el.getAttribute('aria-label') ?? el.textContent?.trim(),
        })).filter(s => s.name);
      })()
    `);
    return servers as unknown[];
  },
});

// channels -- List channels in current server
cli({
  site: "discord-app",
  name: "channels",
  description: "List channels in current server",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("discord-app");
    const channels = await p.evaluate(`
      (() => {
        const items = document.querySelectorAll('[class*="channelName"]');
        return Array.from(items).slice(0, 50).map(el => ({
          name: el.textContent?.trim(),
        }));
      })()
    `);
    return channels as unknown[];
  },
});

// read -- Read recent messages
cli({
  site: "discord-app",
  name: "read",
  description: "Read recent messages",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("discord-app");
    const messages = await p.evaluate(`
      (() => {
        const items = document.querySelectorAll(
          '[id^="chat-messages-"] [class*="message"]'
        );
        return Array.from(items).slice(-20).map(el => ({
          author: el.querySelector('[class*="username"]')?.textContent?.trim(),
          content: el.querySelector('[id^="message-content-"]')
            ?.textContent?.trim()?.slice(0, 500),
        }));
      })()
    `);
    return messages as unknown[];
  },
});

// send -- Send message in current channel
cli({
  site: "discord-app",
  name: "send",
  description: "Send message in current channel",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "message",
      required: true,
      positional: true,
      description: "Message to send",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const p = await connectElectronApp("discord-app");
    const input =
      '[class*="textArea"] [role="textbox"], [data-slate-editor="true"]';
    await p.click(input);
    await p.wait(0.2);
    await p.insertText(String(kwargs.message));
    await p.press("Enter");
    return [{ ok: true }];
  },
});

// search -- Search Discord messages
cli({
  site: "discord-app",
  name: "search",
  description: "Search Discord messages",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      required: true,
      positional: true,
      description: "Search query",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const p = await connectElectronApp("discord-app");
    await p.press("f", ["meta"]);
    await p.wait(0.5);
    await p.insertText(String(kwargs.query));
    await p.press("Enter");
    await p.wait(2);
    const results = await p.evaluate(`
      (() => {
        const items = document.querySelectorAll('[class*="searchResult"]');
        return Array.from(items).slice(0, 10).map(el => ({
          content: el.textContent?.trim()?.slice(0, 200),
        }));
      })()
    `);
    return results as unknown[];
  },
});

// members -- List server members
cli({
  site: "discord-app",
  name: "members",
  description: "List server members",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("discord-app");
    const members = await p.evaluate(`
      (() => {
        const items = document.querySelectorAll('[class*="member-"]');
        return Array.from(items).slice(0, 50).map(el => ({
          name: el.querySelector('[class*="username"]')?.textContent?.trim(),
          status: el.querySelector('[class*="status"]')?.textContent?.trim(),
        }));
      })()
    `);
    return members as unknown[];
  },
});

// status -- Discord app status
cli({
  site: "discord-app",
  name: "status",
  description: "Discord app status",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("discord-app");
    const title = await p.title();
    return [{ app: "Discord", title }];
  },
});
