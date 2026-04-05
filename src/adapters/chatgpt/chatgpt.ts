/**
 * ChatGPT desktop app adapter -- standard AI chat commands.
 *
 * Commands: ask, send, read, model, status, new, screenshot, dump
 */

import { registerAIChatCommands } from "../_electron/shared.js";

registerAIChatCommands("chatgpt", {
  inputSelector:
    "#prompt-textarea, [data-testid='send-button']~textarea, .ProseMirror",
  responseSelector:
    "[data-message-author-role='assistant']:last-child .markdown",
  modelSelector: "[data-testid='model-switcher'] span, .model-selector",
  newChatSelector: "key:Meta+shift+o",
  displayName: "ChatGPT",
});
