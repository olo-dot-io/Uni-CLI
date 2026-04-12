/**
 * Discord desktop app adapter -- server/channel navigation + messaging.
 *
 * Commands: servers, channels, read, send, search, members, delete, status
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

// delete -- Delete a message by ID
cli({
  site: "discord-app",
  name: "delete",
  description: "Delete a message by its ID in the active Discord channel",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "message_id",
      required: true,
      positional: true,
      description:
        "The numeric snowflake ID of the message to delete (visible via Developer Mode)",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const messageId = String(kwargs.message_id);
    if (!/^\d+$/.test(messageId)) {
      return [
        {
          status: "error",
          message: `Invalid message ID: "${messageId}". A Discord message ID is a numeric snowflake.`,
        },
      ];
    }

    const p = await connectElectronApp("discord-app");
    await p.wait(0.5);

    const result = (await p.evaluate(`
      (async () => {
        try {
          const messageId = ${JSON.stringify(messageId)};
          const msgEl = document.querySelector('[id$="-' + messageId + '"]');
          if (!msgEl) {
            return { ok: false, message: 'Could not find message with ID ' + messageId };
          }
          const listItem = msgEl.closest('[id^="chat-messages-"]') || msgEl;

          // Hover to reveal toolbar
          listItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          listItem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          await new Promise(r => setTimeout(r, 500));

          // Find "More" button in toolbar
          const toolbar = listItem.querySelector('[class*="toolbar"]') ||
            document.querySelector('[id^="message-actions-"]');
          if (!toolbar) {
            return { ok: false, message: 'Could not find message action toolbar.' };
          }
          const buttons = Array.from(toolbar.querySelectorAll('button, [role="button"]'));
          const moreBtn = buttons.find(btn => {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            return label === 'more' || label.includes('more');
          });
          if (!moreBtn) {
            return { ok: false, message: 'Could not find "More" button on toolbar.' };
          }
          moreBtn.click();
          await new Promise(r => setTimeout(r, 500));

          // Find "Delete Message" in context menu
          const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
          const deleteItem = menuItems.find(item => {
            const text = (item.textContent || '').trim().toLowerCase();
            return text.includes('delete message') || text === 'delete';
          });
          if (!deleteItem) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { ok: false, message: 'No "Delete Message" option found.' };
          }
          deleteItem.click();
          await new Promise(r => setTimeout(r, 500));

          // Confirm deletion
          const confirmBtn = document.querySelector(
            '[type="submit"], button[class*="colorRed"], button[class*="danger"]'
          );
          if (!confirmBtn) {
            return { ok: false, message: 'Delete confirmation dialog did not appear.' };
          }
          confirmBtn.click();
          return { ok: true, message: 'Message ' + messageId + ' deleted successfully.' };
        } catch (e) {
          return { ok: false, message: String(e) };
        }
      })()
    `)) as { ok: boolean; message: string };

    return [
      {
        status: result.ok ? "success" : "failed",
        message: result.message,
      },
    ];
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
