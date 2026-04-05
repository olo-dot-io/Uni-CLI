/**
 * Cursor IDE adapter -- AI chat + composer + code extraction.
 *
 * Commands: ask, send, read, model, status, new, screenshot, dump, composer, extract-code
 */

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
    await p.press("k", ["meta"]); // Cmd+K for composer
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
