/**
 * Shared Electron desktop command pack.
 *
 * This file intentionally registers commands on many app-specific sites
 * instead of exposing one generic "electron" site. Agents discover
 * `netease-music play-liked`, `slack open-app`, `figma click-text`, etc.
 */

import { registerElectronDesktopCommands } from "../_electron/desktop-shared.js";

registerElectronDesktopCommands("cursor", { displayName: "Cursor" });
registerElectronDesktopCommands("codex", { displayName: "Codex" });
registerElectronDesktopCommands("chatgpt", { displayName: "ChatGPT" });
registerElectronDesktopCommands("notion", { displayName: "Notion" });
registerElectronDesktopCommands("discord-app", { displayName: "Discord" });
registerElectronDesktopCommands("chatwise", { displayName: "ChatWise" });
registerElectronDesktopCommands("doubao-app", { displayName: "Doubao" });
registerElectronDesktopCommands("antigravity", { displayName: "Antigravity" });
registerElectronDesktopCommands("netease-music", {
  displayName: "NetEase Cloud Music",
  media: { likedText: "我喜欢的音乐", playAllText: "播放全部" },
});
registerElectronDesktopCommands("vscode", {
  displayName: "Visual Studio Code",
});
registerElectronDesktopCommands("slack", { displayName: "Slack" });
registerElectronDesktopCommands("figma", { displayName: "Figma" });
registerElectronDesktopCommands("obsidian", { displayName: "Obsidian" });
registerElectronDesktopCommands("logseq", { displayName: "Logseq" });
registerElectronDesktopCommands("typora", { displayName: "Typora" });
registerElectronDesktopCommands("postman", { displayName: "Postman" });
registerElectronDesktopCommands("insomnia", { displayName: "Insomnia" });
registerElectronDesktopCommands("bitwarden", { displayName: "Bitwarden" });
registerElectronDesktopCommands("signal", { displayName: "Signal" });
registerElectronDesktopCommands("whatsapp", { displayName: "WhatsApp" });
registerElectronDesktopCommands("teams", { displayName: "Microsoft Teams" });
registerElectronDesktopCommands("linear", { displayName: "Linear" });
registerElectronDesktopCommands("todoist", { displayName: "Todoist" });
registerElectronDesktopCommands("github-desktop", {
  displayName: "GitHub Desktop",
});
registerElectronDesktopCommands("gitkraken", { displayName: "GitKraken" });
registerElectronDesktopCommands("docker-desktop", {
  displayName: "Docker Desktop",
});
registerElectronDesktopCommands("lm-studio", { displayName: "LM Studio" });
registerElectronDesktopCommands("claude", { displayName: "Claude" });
registerElectronDesktopCommands("perplexity", { displayName: "Perplexity" });
registerElectronDesktopCommands("spotify", {
  displayName: "Spotify",
  media: { likedText: "Liked Songs", playAllText: "Play" },
});
registerElectronDesktopCommands("dingtalk", { displayName: "DingTalk" });
registerElectronDesktopCommands("lark", { displayName: "Lark" });
registerElectronDesktopCommands("wechat-work", { displayName: "WeCom" });
registerElectronDesktopCommands("zoom-app", { displayName: "Zoom" });
registerElectronDesktopCommands("evernote-app", { displayName: "Evernote" });
