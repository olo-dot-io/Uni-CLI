/**
 * OpenAI Codex adapter -- AI chat + diff extraction.
 *
 * Commands: ask, send, read, model, status, new, screenshot, dump, extract-diff
 */

import {
  registerAIChatCommands,
  connectElectronApp,
} from "../_electron/shared.js";
import { cli, Strategy } from "../../registry.js";

registerAIChatCommands("codex", {
  inputSelector: ".input-area textarea, [role='textbox']",
  responseSelector: ".message:last-child .content, .response:last-child",
  modelSelector: ".model-indicator, [data-testid='model']",
  newChatSelector: "key:Meta+n",
  displayName: "Codex",
});

// extract-diff -- Extract diff patches from last response
cli({
  site: "codex",
  name: "extract-diff",
  description: "Extract diff patches from the last Codex response",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("codex");
    const diffs = await p.evaluate(`
      (() => {
        const blocks = document.querySelectorAll(
          '.message:last-child pre code.language-diff, .response:last-child .diff-block'
        );
        return Array.from(blocks).map(b => b.textContent);
      })()
    `);
    return (diffs as string[]).map((d) => ({ diff: d }));
  },
});
