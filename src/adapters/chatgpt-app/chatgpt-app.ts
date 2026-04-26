import { registerAIChatCommands } from "../_electron/shared.js";

registerAIChatCommands("chatgpt-app", {
  inputSelector:
    "#prompt-textarea, [data-testid='prompt-textarea'], .ProseMirror",
  responseSelector:
    "[data-message-author-role='assistant']:last-child .markdown, [data-testid='conversation-turn-2']",
  modelSelector: "[data-testid='model-switcher'] span, .model-selector",
  newChatSelector: "key:Meta+n",
  displayName: "ChatGPT",
});
