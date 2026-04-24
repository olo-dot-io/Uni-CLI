import { cli, Strategy } from "../../registry.js";
import {
  getElectronApp,
  resolveAppControlPolicy,
} from "../../electron-apps.js";
import { launchElectronApp } from "../../browser/launcher.js";
import { connectElectronApp } from "./shared.js";
import type { BrowserPage } from "../../browser/page.js";

export interface ElectronMediaProfile {
  likedText: string;
  playAllText: string;
}

export interface ElectronDesktopCommandProfile {
  displayName?: string;
  media?: ElectronMediaProfile;
}

export const ELECTRON_DESKTOP_BASE_COMMANDS = [
  "open-app",
  "status-app",
  "dump",
  "snapshot-app",
  "click-text",
  "type-text",
  "press",
] as const;

export const ELECTRON_DESKTOP_MEDIA_COMMANDS = [
  "play-liked",
  "play",
  "pause",
  "toggle",
  "next",
  "prev",
] as const;

export function registerElectronDesktopCommands(
  site: string,
  profile: ElectronDesktopCommandProfile = {},
): void {
  const app = getElectronApp(site);
  const displayName = profile.displayName ?? app?.displayName ?? site;

  cli({
    site,
    name: "open-app",
    description: `Open ${displayName} desktop Electron app with CDP enabled for AI control. 打开${displayName}桌面版并启用 CDP 控制。`,
    strategy: Strategy.PUBLIC,
    func: async () => {
      const endpoint = await launchElectronApp(site);
      return [
        {
          app: displayName,
          site,
          port: endpoint.port,
          wsUrl: endpoint.wsUrl,
          policy: resolveAppControlPolicy(site),
        },
      ];
    },
  });

  cli({
    site,
    name: "status-app",
    description: `Inspect current ${displayName} desktop app page, title, URL, visible controls, and text summary. 查看${displayName}桌面版当前状态和可见内容。`,
    strategy: Strategy.PUBLIC,
    func: async () => [await readDesktopStatus(site, displayName)],
  });

  cli({
    site,
    name: "dump",
    description: `Dump visible text from the ${displayName} desktop Electron app via CDP DOM. 读取${displayName}桌面版可见文本。`,
    strategy: Strategy.PUBLIC,
    args: [
      {
        name: "limit",
        required: false,
        positional: false,
        description: "Maximum text characters to return",
      },
    ],
    func: async (_page: unknown, kwargs: Record<string, unknown>) => {
      const p = await connectElectronApp(site);
      const limit = readInt(kwargs.limit, 2000);
      return [await dumpVisibleText(p, displayName, limit)];
    },
  });

  cli({
    site,
    name: "snapshot-app",
    description: `List visible clickable text, buttons, inputs, and regions in ${displayName}. 枚举${displayName}桌面版可交互内容。`,
    strategy: Strategy.PUBLIC,
    func: async () => {
      const p = await connectElectronApp(site);
      return (await p.evaluate(visibleInteractivesJs())) as unknown[];
    },
  });

  cli({
    site,
    name: "click-text",
    description: `Click visible text, aria-label, title, or button content in ${displayName}. 按文本点击${displayName}桌面版控件。`,
    strategy: Strategy.PUBLIC,
    args: [
      {
        name: "text",
        required: true,
        positional: true,
        description: "Visible text, aria-label, or title to click",
      },
    ],
    func: async (_page: unknown, kwargs: Record<string, unknown>) => {
      const p = await connectElectronApp(site);
      return [await clickVisibleText(p, String(kwargs.text), displayName)];
    },
  });

  cli({
    site,
    name: "type-text",
    description: `Type text into the focused field or a text-matched target in ${displayName}. 向${displayName}桌面版输入文本。`,
    strategy: Strategy.PUBLIC,
    args: [
      {
        name: "text",
        required: true,
        positional: true,
        description: "Text to type",
      },
      {
        name: "target",
        required: false,
        positional: false,
        description: "Optional visible text to click before typing",
      },
    ],
    func: async (_page: unknown, kwargs: Record<string, unknown>) => {
      const p = await connectElectronApp(site);
      if (kwargs.target !== undefined) {
        await clickVisibleText(p, String(kwargs.target), displayName);
      }
      await p.insertText(String(kwargs.text));
      return [{ app: displayName, typed: true }];
    },
  });

  cli({
    site,
    name: "press",
    description: `Press a key in ${displayName}, with optional comma-separated modifiers. 在${displayName}桌面版发送按键。`,
    strategy: Strategy.PUBLIC,
    args: [
      {
        name: "key",
        required: true,
        positional: true,
        description: "Key name",
      },
      {
        name: "modifiers",
        required: false,
        positional: false,
        description: "Comma-separated modifiers such as meta,shift",
      },
    ],
    func: async (_page: unknown, kwargs: Record<string, unknown>) => {
      const p = await connectElectronApp(site);
      const modifiers =
        typeof kwargs.modifiers === "string"
          ? kwargs.modifiers
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
      await p.press(String(kwargs.key), modifiers);
      return [{ app: displayName, key: String(kwargs.key), modifiers }];
    },
  });

  if (profile.media) {
    registerMediaCommands(site, displayName, profile.media);
  }
}

function registerMediaCommands(
  site: string,
  displayName: string,
  media: ElectronMediaProfile,
): void {
  cli({
    site,
    name: "play-liked",
    description: `Open ${displayName} liked songs and play the liked playlist. 打开${displayName}我喜欢的音乐/喜欢的歌曲并播放。`,
    strategy: Strategy.PUBLIC,
    func: async () => {
      const p = await connectElectronApp(site);
      const liked = await clickVisibleText(p, media.likedText, displayName);
      await p.wait(1);
      const play = await clickVisibleText(p, media.playAllText, displayName);
      await p.wait(1.5);
      return [{ app: displayName, liked, play, status: await mediaStatus(p) }];
    },
  });

  for (const action of ["play", "pause", "toggle", "next", "prev"] as const) {
    cli({
      site,
      name: action,
      description: `${action} playback in the ${displayName} desktop app. 控制${displayName}桌面版播放：${action}。`,
      strategy: Strategy.PUBLIC,
      func: async () => {
        const p = await connectElectronApp(site);
        const clicked = await clickMediaControl(p, action, displayName);
        await p.wait(0.8);
        return [
          { app: displayName, action, clicked, status: await mediaStatus(p) },
        ];
      },
    });
  }
}

async function readDesktopStatus(
  site: string,
  displayName: string,
): Promise<Record<string, unknown>> {
  const endpoint = await launchElectronApp(site);
  const p = await connectElectronApp(site);
  return {
    app: displayName,
    site,
    port: endpoint.port,
    title: await p.title(),
    url: await p.url(),
    policy: resolveAppControlPolicy(site),
    content: await dumpVisibleText(p, displayName, 700),
    controls: await p.evaluate(visibleInteractivesJs(20)),
  };
}

async function dumpVisibleText(
  p: BrowserPage,
  app: string,
  limit: number,
): Promise<Record<string, unknown>> {
  const text = (await p.evaluate(
    `document.body.innerText.slice(0, ${Math.max(1, limit)})`,
  )) as string;
  return { app, text };
}

async function clickVisibleText(
  p: BrowserPage,
  text: string,
  app: string,
): Promise<Record<string, unknown>> {
  const result = (await p.evaluate(clickTextJs(text))) as {
    found: boolean;
    x?: number;
    y?: number;
    text?: string;
  };
  if (!result.found || result.x === undefined || result.y === undefined) {
    return { app, clicked: false, text, reason: "text_not_found" };
  }
  await p.nativeClick(result.x, result.y);
  return { app, clicked: true, match: result.text, x: result.x, y: result.y };
}

async function clickMediaControl(
  p: BrowserPage,
  action: "play" | "pause" | "toggle" | "next" | "prev",
  app: string,
): Promise<Record<string, unknown>> {
  const target = (await p.evaluate(mediaControlJs(action))) as {
    found: boolean;
    x?: number;
    y?: number;
    label?: string;
  };
  if (!target.found || target.x === undefined || target.y === undefined) {
    return { app, clicked: false, action, reason: "control_not_found" };
  }
  await p.nativeClick(target.x, target.y);
  return { app, clicked: true, action, label: target.label };
}

async function mediaStatus(p: BrowserPage): Promise<unknown> {
  return p.evaluate(`
    (() => {
      const pause = Array.from(document.querySelectorAll('button[title="暂停"]'))
        .find(el => el.getBoundingClientRect().y < innerHeight - 90);
      const row = pause?.closest('.tr');
      return {
        playing: !!pause,
        currentRow: (row?.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
        bodyTail: document.body.innerText.slice(-300)
      };
    })()
  `);
}

function clickTextJs(text: string): string {
  return `
    (() => {
      const needle = ${JSON.stringify(text)}.trim().toLowerCase();
      const nodes = Array.from(document.querySelectorAll('button,a,[role],div,span,input,textarea'));
      for (const el of nodes) {
        const raw = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || el.placeholder || '').trim();
        if (!raw) continue;
        const hay = raw.toLowerCase();
        if (hay !== needle && !hay.includes(needle)) continue;
        const target = el.closest('button,a,[role="button"],.ItemContainer_ijv59hq,.tr') || el;
        const r = target.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.x < -5 || r.y < -5) continue;
        return { found: true, text: raw.slice(0, 160), x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return { found: false };
    })()
  `;
}

function mediaControlJs(action: string): string {
  return `
    (() => {
      const bottom = Array.from(document.querySelectorAll('button')).map((el, index) => {
        const r = el.getBoundingClientRect();
        const label = [el.title, el.getAttribute('aria-label'), el.innerText, el.textContent].filter(Boolean).join(' ').trim();
        return { el, index, label, cls: String(el.className || ''), x: r.x, y: r.y, w: r.width, h: r.height };
      }).filter(b => b.w > 0 && b.h > 0 && b.y > innerHeight - 90).sort((a, b) => a.x - b.x);
      const pick = (b) => ({ found: true, label: b.label || b.cls, x: b.x + b.w / 2, y: b.y + b.h / 2 });
      const rx = {
        next: /下一首|下一个|next/i,
        prev: /上一首|上一个|previous|prev/i,
        play: /播放|play/i,
        pause: /暂停|pause/i
      }[${JSON.stringify(action)}];
      if (rx) {
        const labeled = bottom.find(b => rx.test(b.label));
        if (labeled) return pick(labeled);
      }
      const center = bottom.find(b => b.cls.includes('play-pause-btn')) ||
        bottom.slice().sort((a, b) => Math.abs((a.x + a.w / 2) - innerWidth / 2) - Math.abs((b.x + b.w / 2) - innerWidth / 2))[0];
      if (!center) return { found: false };
      if (${JSON.stringify(action)} === 'toggle' || ${JSON.stringify(action)} === 'play' || ${JSON.stringify(action)} === 'pause') return pick(center);
      const idx = bottom.indexOf(center);
      const neighbor = ${JSON.stringify(action)} === 'next' ? bottom[idx + 1] : bottom[idx - 1];
      return neighbor ? pick(neighbor) : { found: false };
    })()
  `;
}

function visibleInteractivesJs(limit = 80): string {
  return `
    (() => {
      const out = [];
      const nodes = document.querySelectorAll('button,a,input,textarea,[role="button"],[role="textbox"],[contenteditable="true"]');
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.y < -5 || r.y > innerHeight + 5) continue;
        const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || el.placeholder || '').trim().replace(/\\s+/g, ' ');
        out.push({ tag: el.tagName, role: el.getAttribute('role'), text: text.slice(0, 120), title: el.title, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
        if (out.length >= ${limit}) break;
      }
      return out;
    })()
  `;
}

function readInt(value: unknown, fallback: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}
