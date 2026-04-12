/**
 * Cursor IDE adapter -- AI chat + composer + code extraction.
 *
 * Commands: ask, send, read, model, status, new, screenshot, dump,
 *           composer, extract-code, export, history
 */

import { writeFileSync } from "node:fs";
import {
  registerAIChatCommands,
  connectElectronApp,
} from "../_electron/shared.js";
import { cli, Strategy } from "../../registry.js";

registerAIChatCommands("cursor", {
  inputSelector:
    ".chat-input textarea, [data-testid='chat-input'] textarea, .composer-input textarea",
  responseSelector:
    ".chat-message:last-child .message-content, .response-container:last-child",
  modelSelector: ".model-selector .current-model, [data-testid='model-name']",
  newChatSelector: "key:Meta+n",
  displayName: "Cursor",
});

// composer -- Open Cursor Composer with a prompt
cli({
  site: "cursor",
  name: "composer",
  description: "Open Cursor Composer mode with a prompt",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "prompt",
      required: true,
      positional: true,
      description: "The prompt to send to Composer",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const p = await connectElectronApp("cursor");
    await p.press("i", ["meta"]); // Cmd+I for Composer
    await p.wait(0.5);
    await p.insertText(String(kwargs.prompt));
    await p.press("Enter");
    return [{ ok: true }];
  },
});

// extract-code -- Extract code blocks from last response
cli({
  site: "cursor",
  name: "extract-code",
  description: "Extract code blocks from the last Cursor response",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("cursor");
    const code = await p.evaluate(`
      (() => {
        const blocks = document.querySelectorAll(
          '.chat-message:last-child pre code, .response-container:last-child pre code'
        );
        return Array.from(blocks).map(b => ({
          language: b.className.replace('language-', ''),
          code: b.textContent,
        }));
      })()
    `);
    return code as unknown[];
  },
});

// export -- Export current conversation to Markdown file
cli({
  site: "cursor",
  name: "export",
  description: "Export the current Cursor conversation to a Markdown file",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "output",
      required: false,
      positional: true,
      default: "/tmp/cursor-export.md",
      description: "Output file path",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const outputPath = String(kwargs.output ?? "/tmp/cursor-export.md");
    const p = await connectElectronApp("cursor");
    const md = (await p.evaluate(`
      (() => {
        const selectors = '[data-message-role]';
        const messages = Array.from(document.querySelectorAll(selectors));
        if (messages.length === 0) {
          const main = document.querySelector('main, [role="main"], .messages-list');
          if (main) return [main.innerText || main.textContent];
          return [document.body.innerText];
        }
        return messages.map((m, i) => {
          const role = m.getAttribute('data-message-role');
          const root = m.querySelector('.markdown-root');
          const text = root ? root.innerText : m.innerText;
          return '## ' + (role === 'human' ? 'User' : 'Assistant') + '\\n\\n' + (text || '').trim();
        }).join('\\n\\n---\\n\\n');
      })()
    `)) as string;

    writeFileSync(outputPath, `# Cursor Conversation Export\n\n${md}`);
    const messageCount = (md.match(/^## /gm) || []).length;
    return [{ status: "exported", file: outputPath, messages: messageCount }];
  },
});

// history -- List recent chat sessions from Cursor sidebar
cli({
  site: "cursor",
  name: "history",
  description: "List recent chat sessions from the Cursor sidebar",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("cursor");
    const items = (await p.evaluate(`
      (() => {
        const results = [];
        const entries = document.querySelectorAll(
          '.agent-sidebar-list-item, [data-testid="chat-history-item"], .chat-history-item, .tree-item'
        );
        entries.forEach((item, i) => {
          const title = (item.textContent || item.innerText || '').trim().substring(0, 100);
          if (title) results.push({ index: i + 1, title });
        });
        if (results.length === 0) {
          const sidebar = document.querySelector(
            '.sidebar, [class*="sidebar"], .agent-sidebar, .side-bar-container'
          );
          if (sidebar) {
            const links = sidebar.querySelectorAll('a, [role="treeitem"], [role="option"]');
            links.forEach((link, i) => {
              const text = (link.textContent || '').trim().substring(0, 100);
              if (text) results.push({ index: i + 1, title: text });
            });
          }
        }
        return results;
      })()
    `)) as unknown[];

    if (!items || (items as Array<unknown>).length === 0) {
      return [
        {
          index: 0,
          title: "No chat history found. Open the AI sidebar first.",
        },
      ];
    }
    return items;
  },
});
