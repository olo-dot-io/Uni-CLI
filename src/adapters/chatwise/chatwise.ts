/**
 * ChatWise desktop app adapter -- standard AI chat commands.
 *
 * Commands: ask, send, read, model, status, new, screenshot, dump
 */

import { registerAIChatCommands } from "../_electron/shared.js";

registerAIChatCommands("chatwise", {
  inputSelector: ".chat-input textarea, [contenteditable='true']",
  responseSelector:
    ".message-assistant:last-child .content, .bot-message:last-child",
  modelSelector: ".model-name, .current-model",
  newChatSelector: "key:Meta+n",
  displayName: "ChatWise",
});
