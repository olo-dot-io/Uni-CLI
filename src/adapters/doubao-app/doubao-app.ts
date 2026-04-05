/**
 * Doubao (ByteDance) desktop app adapter -- standard AI chat commands.
 *
 * Commands: ask, send, read, status, new, screenshot, dump
 */

import { registerAIChatCommands } from "../_electron/shared.js";

registerAIChatCommands("doubao-app", {
  inputSelector: ".chat-input textarea, [data-testid='chat-input']",
  responseSelector:
    ".assistant-message:last-child .content, .message-bot:last-child",
  newChatSelector: "key:Meta+n",
  displayName: "Doubao",
});
