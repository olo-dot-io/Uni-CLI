/**
 * Antigravity desktop app adapter -- standard AI chat commands.
 *
 * Commands: ask, send, read, model, status, new, screenshot, dump
 */

import { registerAIChatCommands } from "../_electron/shared.js";

registerAIChatCommands("antigravity", {
  inputSelector: ".chat-input textarea, [contenteditable='true']",
  responseSelector:
    ".assistant-message:last-child .content, .response:last-child",
  modelSelector: ".model-indicator",
  newChatSelector: "key:Meta+n",
  displayName: "Antigravity",
});
