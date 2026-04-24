/**
 * Electron app registry — known Electron apps with CDP debug ports.
 *
 * Each app gets a unique CDP port for parallel debugging.
 * Users can extend via ~/.unicli/apps.yaml (additive only).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export type AppInspectionSurface =
  | "cdp-dom"
  | "desktop-ax"
  | "background-click"
  | "cua";

export interface AppBackgroundClickPolicy {
  enabled: boolean;
  flagsWhenBackgrounded: "command";
  location: "window-local";
}

export interface AppControlPolicy {
  inspectionOrder: AppInspectionSurface[];
  axEmptyTreeFallback: AppInspectionSurface;
  backgroundClick: AppBackgroundClickPolicy;
}

export type ElectronAppKind =
  | "ai-chat"
  | "code"
  | "collaboration"
  | "design"
  | "dev-tool"
  | "docs"
  | "media"
  | "productivity"
  | "security";

export interface ElectronAppEntry {
  port: number;
  processName: string;
  aliases?: string[];
  executableNames?: string[];
  bundleId?: string;
  displayName?: string;
  extraArgs?: string[];
  kind?: ElectronAppKind;
  contentHints?: string[];
  control?: Partial<AppControlPolicy>;
}

const DEFAULT_CONTROL_POLICY: AppControlPolicy = {
  inspectionOrder: ["desktop-ax", "cdp-dom", "cua"],
  axEmptyTreeFallback: "cdp-dom",
  backgroundClick: {
    enabled: false,
    flagsWhenBackgrounded: "command",
    location: "window-local",
  },
};

const BUILTIN_APPS: Record<string, ElectronAppEntry> = {
  cursor: {
    port: 9226,
    processName: "Cursor",
    bundleId: "com.todesktop.runtime.Cursor",
    displayName: "Cursor",
    kind: "code",
    contentHints: ["chat", "composer", "code", "diff", "workspace"],
  },
  codex: {
    port: 9222,
    processName: "Codex",
    bundleId: "com.openai.codex",
    displayName: "Codex CLI",
    kind: "ai-chat",
    contentHints: ["chat", "task", "diff", "terminal"],
  },
  chatgpt: {
    port: 9236,
    processName: "ChatGPT",
    bundleId: "com.openai.chat",
    displayName: "ChatGPT",
    kind: "ai-chat",
    contentHints: ["chat", "conversation", "model"],
  },
  notion: {
    port: 9230,
    processName: "Notion",
    bundleId: "notion.id",
    displayName: "Notion",
    kind: "docs",
    contentHints: ["page", "database", "document", "workspace"],
  },
  "discord-app": {
    port: 9232,
    processName: "Discord",
    bundleId: "com.hnc.Discord",
    displayName: "Discord",
    kind: "collaboration",
    contentHints: ["server", "channel", "message", "member"],
  },
  chatwise: {
    port: 9228,
    processName: "ChatWise",
    bundleId: "com.chatwise.app",
    displayName: "ChatWise",
    kind: "ai-chat",
    contentHints: ["chat", "model", "conversation"],
  },
  "doubao-app": {
    port: 9225,
    processName: "Doubao",
    bundleId: "com.volcengine.doubao",
    displayName: "Doubao",
    aliases: ["豆包", "豆包 app", "doubao desktop"],
    kind: "ai-chat",
    contentHints: ["chat", "conversation", "agent"],
  },
  antigravity: {
    port: 9234,
    processName: "Antigravity",
    executableNames: ["Electron", "Antigravity"],
    bundleId: "dev.antigravity.app",
    displayName: "Antigravity",
    kind: "code",
    contentHints: ["agent", "code", "workspace", "task"],
  },
  "netease-music": {
    port: 9238,
    processName: "NeteaseMusic",
    aliases: [
      "netease music",
      "netease music app",
      "netease cloud music",
      "net ease music",
      "网易云",
      "网易云音乐",
      "网易云音乐 app",
    ],
    executableNames: ["NeteaseMusic", "网易云音乐"],
    bundleId: "com.netease.163music",
    displayName: "NeteaseMusic",
    kind: "media",
    contentHints: ["music", "song", "playlist", "liked songs", "我喜欢的音乐"],
    control: {
      inspectionOrder: ["cdp-dom", "desktop-ax", "background-click", "cua"],
      axEmptyTreeFallback: "cdp-dom",
      backgroundClick: {
        enabled: true,
        flagsWhenBackgrounded: "command",
        location: "window-local",
      },
    },
  },
  vscode: {
    port: 9240,
    processName: "Visual Studio Code",
    aliases: ["vs code", "code", "vscode", "visual studio code"],
    executableNames: ["Electron", "Code"],
    bundleId: "com.microsoft.VSCode",
    displayName: "Visual Studio Code",
    kind: "code",
    contentHints: ["editor", "terminal", "workspace", "extensions"],
  },
  slack: {
    port: 9241,
    processName: "Slack",
    bundleId: "com.tinyspeck.slackmacgap",
    displayName: "Slack",
    kind: "collaboration",
    contentHints: ["workspace", "channel", "message", "thread"],
  },
  figma: {
    port: 9242,
    processName: "Figma",
    bundleId: "com.figma.Desktop",
    displayName: "Figma",
    kind: "design",
    contentHints: ["file", "page", "frame", "selection", "export"],
  },
  obsidian: {
    port: 9243,
    processName: "Obsidian",
    bundleId: "md.obsidian",
    displayName: "Obsidian",
    kind: "docs",
    contentHints: ["vault", "note", "daily note", "markdown"],
  },
  logseq: {
    port: 9244,
    processName: "Logseq",
    bundleId: "com.electron.logseq",
    displayName: "Logseq",
    kind: "docs",
    contentHints: ["graph", "journal", "block", "page"],
  },
  typora: {
    port: 9245,
    processName: "Typora",
    bundleId: "abnerworks.Typora",
    displayName: "Typora",
    kind: "docs",
    contentHints: ["markdown", "document", "editor"],
  },
  postman: {
    port: 9246,
    processName: "Postman",
    bundleId: "com.postmanlabs.mac",
    displayName: "Postman",
    kind: "dev-tool",
    contentHints: ["request", "collection", "environment", "api"],
  },
  insomnia: {
    port: 9247,
    processName: "Insomnia",
    bundleId: "com.insomnia.app",
    displayName: "Insomnia",
    kind: "dev-tool",
    contentHints: ["request", "collection", "graphql", "api"],
  },
  bitwarden: {
    port: 9248,
    processName: "Bitwarden",
    bundleId: "com.bitwarden.desktop",
    displayName: "Bitwarden",
    kind: "security",
    contentHints: ["vault", "item", "login", "password"],
  },
  signal: {
    port: 9249,
    processName: "Signal",
    bundleId: "org.whispersystems.signal-desktop",
    displayName: "Signal",
    kind: "collaboration",
    contentHints: ["chat", "message", "contact", "conversation"],
  },
  whatsapp: {
    port: 9250,
    processName: "WhatsApp",
    aliases: ["whatsapp desktop"],
    bundleId: "net.whatsapp.WhatsApp",
    displayName: "WhatsApp",
    kind: "collaboration",
    contentHints: ["chat", "message", "contact", "conversation"],
  },
  teams: {
    port: 9251,
    processName: "Microsoft Teams",
    aliases: ["ms teams", "teams"],
    executableNames: ["Teams", "Microsoft Teams"],
    bundleId: "com.microsoft.teams2",
    displayName: "Microsoft Teams",
    kind: "collaboration",
    contentHints: ["chat", "meeting", "channel", "calendar"],
  },
  linear: {
    port: 9252,
    processName: "Linear",
    bundleId: "com.linear",
    displayName: "Linear",
    kind: "productivity",
    contentHints: ["issue", "project", "cycle", "roadmap"],
  },
  todoist: {
    port: 9253,
    processName: "Todoist",
    bundleId: "com.todoist.mac.Todoist",
    displayName: "Todoist",
    kind: "productivity",
    contentHints: ["task", "project", "today", "inbox"],
  },
  "github-desktop": {
    port: 9254,
    processName: "GitHub Desktop",
    aliases: ["github desktop"],
    executableNames: ["GitHub Desktop"],
    bundleId: "com.github.GitHubClient",
    displayName: "GitHub Desktop",
    kind: "dev-tool",
    contentHints: ["repository", "commit", "branch", "pull request"],
  },
  gitkraken: {
    port: 9255,
    processName: "GitKraken",
    bundleId: "com.axosoft.gitkraken",
    displayName: "GitKraken",
    kind: "dev-tool",
    contentHints: ["repository", "commit", "branch", "graph"],
  },
  "docker-desktop": {
    port: 9256,
    processName: "Docker",
    aliases: ["docker desktop"],
    executableNames: ["Docker"],
    bundleId: "com.docker.docker",
    displayName: "Docker",
    kind: "dev-tool",
    contentHints: ["container", "image", "volume", "extension"],
  },
  "lm-studio": {
    port: 9257,
    processName: "LM Studio",
    aliases: ["lmstudio", "lm studio"],
    executableNames: ["LM Studio"],
    bundleId: "ai.elementlabs.lmstudio",
    displayName: "LM Studio",
    kind: "ai-chat",
    contentHints: ["model", "chat", "local server", "prompt"],
  },
  claude: {
    port: 9258,
    processName: "Claude",
    aliases: ["claude desktop", "anthropic claude"],
    bundleId: "com.anthropic.claudefordesktop",
    displayName: "Claude",
    kind: "ai-chat",
    contentHints: ["chat", "conversation", "artifact", "project"],
  },
  perplexity: {
    port: 9259,
    processName: "Perplexity",
    bundleId: "ai.perplexity.mac",
    displayName: "Perplexity",
    kind: "ai-chat",
    contentHints: ["search", "answer", "thread", "source"],
  },
  spotify: {
    port: 9260,
    processName: "Spotify",
    bundleId: "com.spotify.client",
    displayName: "Spotify",
    kind: "media",
    contentHints: ["music", "song", "playlist", "liked songs"],
  },
  dingtalk: {
    port: 9261,
    processName: "DingTalk",
    aliases: ["钉钉", "dingtalk desktop"],
    bundleId: "com.alibaba.DingTalkMac",
    displayName: "DingTalk",
    kind: "collaboration",
    contentHints: ["chat", "meeting", "document", "calendar"],
  },
  lark: {
    port: 9262,
    processName: "Lark",
    aliases: ["飞书", "feishu", "lark desktop"],
    bundleId: "com.electron.lark",
    displayName: "Lark",
    kind: "collaboration",
    contentHints: ["chat", "doc", "meeting", "calendar"],
  },
  "wechat-work": {
    port: 9263,
    processName: "WeCom",
    aliases: ["企业微信", "wecom", "wechat work"],
    executableNames: ["WeCom", "企业微信"],
    bundleId: "com.tencent.WeWorkMac",
    displayName: "WeCom",
    kind: "collaboration",
    contentHints: ["chat", "contact", "meeting", "document"],
  },
  "zoom-app": {
    port: 9264,
    processName: "zoom.us",
    aliases: ["zoom desktop", "zoom app"],
    executableNames: ["zoom.us"],
    bundleId: "us.zoom.xos",
    displayName: "zoom.us",
    kind: "collaboration",
    contentHints: ["meeting", "chat", "participants", "calendar"],
  },
  "evernote-app": {
    port: 9265,
    processName: "Evernote",
    aliases: ["evernote desktop", "印象笔记"],
    bundleId: "com.evernote.Evernote",
    displayName: "Evernote",
    kind: "docs",
    contentHints: ["note", "notebook", "tag", "search"],
  },
};

let _apps: Record<string, ElectronAppEntry> | null = null;

/**
 * Get all known Electron apps (builtins + user extensions).
 * User apps from ~/.unicli/apps.yaml are additive only — cannot override builtins.
 */
export function getElectronApps(): Record<string, ElectronAppEntry> {
  if (_apps) return _apps;

  _apps = { ...BUILTIN_APPS };

  // Load user extensions
  try {
    const userAppsPath = join(homedir(), ".unicli", "apps.yaml");
    const content = readFileSync(userAppsPath, "utf-8");
    const parsed = yaml.load(content) as {
      apps?: Record<string, ElectronAppEntry>;
    };
    if (parsed?.apps) {
      for (const [name, entry] of Object.entries(parsed.apps)) {
        if (!(name in BUILTIN_APPS)) {
          _apps[name] = entry;
        }
      }
    }
  } catch {
    // No user apps file — that's fine
  }

  return _apps;
}

/**
 * Look up an Electron app by site name.
 */
export function getElectronApp(site: string): ElectronAppEntry | null {
  return getElectronApps()[site] ?? null;
}

/**
 * Look up an Electron app by any common identifier:
 * site key, process name, display name, executable name, or bundle ID.
 */
export function findElectronApp(target: string): ElectronAppEntry | null {
  const needle = target.trim().toLowerCase();
  if (!needle) return null;

  const direct = getElectronApp(needle);
  if (direct) return direct;

  for (const [site, entry] of Object.entries(getElectronApps())) {
    if (site.toLowerCase() === needle) return entry;
    if (entry.processName.toLowerCase() === needle) return entry;
    if (entry.displayName?.toLowerCase() === needle) return entry;
    if (entry.bundleId?.toLowerCase() === needle) return entry;
    if (entry.aliases?.some((name) => name.toLowerCase() === needle)) {
      return entry;
    }
    if (entry.executableNames?.some((name) => name.toLowerCase() === needle)) {
      return entry;
    }
  }

  return null;
}

export function resolveAppControlPolicy(target: string): AppControlPolicy {
  const app = findElectronApp(target);
  const control = app?.control;
  return {
    inspectionOrder: control?.inspectionOrder
      ? [...control.inspectionOrder]
      : [...DEFAULT_CONTROL_POLICY.inspectionOrder],
    axEmptyTreeFallback:
      control?.axEmptyTreeFallback ??
      DEFAULT_CONTROL_POLICY.axEmptyTreeFallback,
    backgroundClick: {
      ...DEFAULT_CONTROL_POLICY.backgroundClick,
      ...control?.backgroundClick,
    },
  };
}

/**
 * Check if a site is a known Electron app.
 */
export function isElectronApp(site: string): boolean {
  return site in getElectronApps();
}
