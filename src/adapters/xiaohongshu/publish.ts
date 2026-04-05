/**
 * Xiaohongshu publish — creator center UI automation for image+text notes.
 *
 * Flow:
 *   1. Navigate to creator publish page
 *   2. Upload images via CDP setFileInput
 *   3. Fill title and body text
 *   4. Add topic hashtags
 *   5. Publish (or save as draft)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const PUBLISH_URL =
  "https://creator.xiaohongshu.com/publish/publish?from=menu_left";
const MAX_IMAGES = 9;
const MAX_TITLE_LEN = 20;

const TITLE_SELECTORS = [
  '[contenteditable="true"][placeholder*="标题"]',
  '[contenteditable="true"][placeholder*="赞"]',
  '[contenteditable="true"][class*="title"]',
  'input[maxlength="20"]',
  'input[class*="title"]',
  'input[placeholder*="标题"]',
  ".title-input input",
  ".note-title input",
  "input[maxlength]",
];

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function validateImagePaths(filePaths: string[]): string[] {
  return filePaths.map((filePath) => {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath))
      throw new Error(`Image file not found: ${absPath}`);
    const ext = path.extname(absPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS[ext]) {
      throw new Error(
        `Unsupported image format "${ext}". Supported: jpg, png, gif, webp`,
      );
    }
    return absPath;
  });
}

async function fillField(
  page: IPage,
  selectors: string[],
  text: string,
  fieldName: string,
): Promise<void> {
  const result: { ok: boolean } = (await page.evaluate(`
    (function(selectors, text) {
      for (const sel of selectors) {
        const candidates = document.querySelectorAll(sel);
        for (const el of candidates) {
          if (!el || el.offsetParent === null) continue;
          el.focus();
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.value = '';
            document.execCommand('selectAll', false);
            document.execCommand('insertText', false, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            el.textContent = '';
            document.execCommand('selectAll', false);
            document.execCommand('insertText', false, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return { ok: true };
        }
      }
      return { ok: false };
    })(${JSON.stringify(selectors)}, ${JSON.stringify(text)})
  `)) as { ok: boolean };
  if (!result.ok) {
    throw new Error(`Could not find ${fieldName} input on the page.`);
  }
}

cli({
  site: "xiaohongshu",
  name: "publish",
  description:
    "Publish an image+text note via Xiaohongshu creator center (UI automation)",
  domain: "creator.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "title", required: true, description: "Note title (max 20 chars)" },
    {
      name: "content",
      required: true,
      positional: true,
      description: "Note body text",
    },
    {
      name: "images",
      required: true,
      description: "Image paths, comma-separated, max 9 (jpg/png/gif/webp)",
    },
    {
      name: "topics",
      description: "Topic hashtags, comma-separated, without # symbol",
    },
    {
      name: "draft",
      type: "bool",
      default: false,
      description: "Save as draft instead of publishing",
    },
  ],
  columns: ["status", "detail"],
  func: async (page, kwargs) => {
    const p = page as IPage;

    const title = String(kwargs.title ?? "").trim();
    const content = String(kwargs.content ?? "").trim();
    const imagePaths: string[] = kwargs.images
      ? String(kwargs.images)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [];
    const topics: string[] = kwargs.topics
      ? String(kwargs.topics)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [];
    const isDraft = Boolean(kwargs.draft);

    // Validate inputs
    if (!title) throw new Error("--title is required");
    if (title.length > MAX_TITLE_LEN)
      throw new Error(
        `Title is ${title.length} chars — must be <= ${MAX_TITLE_LEN}`,
      );
    if (!content) throw new Error("Positional argument <content> is required");
    if (imagePaths.length === 0)
      throw new Error("At least one --images path is required.");
    if (imagePaths.length > MAX_IMAGES)
      throw new Error(
        `Too many images: ${imagePaths.length} (max ${MAX_IMAGES})`,
      );

    const absImagePaths = validateImagePaths(imagePaths);

    // Step 1: Navigate to publish page
    await p.goto(PUBLISH_URL);
    await p.wait(3);

    // Step 2: Select image+text tab if present
    await p.evaluate(`
      () => {
        const targets = ['上传图文', '图文', '图片'];
        const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], a, label, div, span, li'));
        for (const target of targets) {
          for (const node of nodes) {
            if (!node || node.offsetParent === null) continue;
            const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!text || text.includes('视频')) continue;
            if (text === target || text.startsWith(target) || text.includes(target)) {
              const clickable = node.closest('button, [role="tab"], [role="button"], a, label') || node;
              clickable.click();
              return true;
            }
          }
        }
        return false;
      }
    `);
    await p.wait(1);

    // Step 3: Upload images via setFileInput
    const selector =
      'input[type="file"][accept*="image"], input[type="file"][accept*=".jpg"]';
    await p.setFileInput(selector, absImagePaths);
    await p.wait(3);

    // Step 4: Wait for edit form to appear
    for (let i = 0; i < 10; i++) {
      const found = (await p.evaluate(`
        (() => {
          const sels = ${JSON.stringify(TITLE_SELECTORS)};
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) return true;
          }
          return false;
        })()
      `)) as boolean;
      if (found) break;
      await p.wait(1);
    }

    // Step 5: Fill title
    await fillField(p, TITLE_SELECTORS, title, "title");
    await p.wait(0.5);

    // Step 6: Fill content
    await fillField(
      p,
      [
        '[contenteditable="true"][class*="content"]',
        '[contenteditable="true"][class*="editor"]',
        '[contenteditable="true"][placeholder*="描述"]',
        '[contenteditable="true"][placeholder*="正文"]',
        '[contenteditable="true"][placeholder*="内容"]',
        '.note-content [contenteditable="true"]',
        '.editor-content [contenteditable="true"]',
        '[contenteditable="true"]:not([placeholder*="标题"]):not([placeholder*="赞"])',
      ],
      content,
      "content",
    );
    await p.wait(0.5);

    // Step 7: Add topic hashtags
    for (const topic of topics) {
      await p.evaluate(`
        () => {
          const candidates = document.querySelectorAll('*');
          for (const el of candidates) {
            const text = (el.innerText || el.textContent || '').trim();
            if (
              (text === '添加话题' || text === '# 话题' || text.startsWith('添加话题')) &&
              el.offsetParent !== null && el.children.length === 0
            ) {
              el.click();
              return true;
            }
          }
          return false;
        }
      `);
      await p.wait(1);

      await p.evaluate(`
        (topicName => {
          const input = document.querySelector('[class*="topic"] input, [class*="hashtag"] input, input[placeholder*="搜索话题"]');
          if (!input || input.offsetParent === null) return false;
          input.focus();
          document.execCommand('insertText', false, topicName);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })(${JSON.stringify(topic)})
      `);
      await p.wait(1.5);

      await p.evaluate(`
        () => {
          const item = document.querySelector('[class*="topic-item"], [class*="hashtag-item"], [class*="suggest-item"]');
          if (item) item.click();
        }
      `);
      await p.wait(0.5);
    }

    // Step 8: Publish or save draft
    const actionLabels = isDraft
      ? ["暂存离开", "存草稿"]
      : ["发布", "发布笔记"];
    const btnClicked = (await p.evaluate(`
      (labels => {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || '').trim();
          if (
            labels.some(l => text === l || text.includes(l)) &&
            btn.offsetParent !== null && !btn.disabled
          ) {
            btn.click();
            return true;
          }
        }
        return false;
      })(${JSON.stringify(actionLabels)})
    `)) as boolean;

    if (!btnClicked) {
      throw new Error(`Could not find "${actionLabels[0]}" button.`);
    }

    await p.wait(4);

    const finalUrl = (await p.evaluate("() => location.href")) as string;
    const navigatedAway = !finalUrl.includes("/publish/publish");
    const verb = isDraft ? "Draft saved" : "Published";

    return [
      {
        status: navigatedAway ? `ok: ${verb}` : `pending: verify in browser`,
        detail: [
          `"${title}"`,
          `${absImagePaths.length} images`,
          topics.length ? `topics: ${topics.join(" ")}` : "",
        ]
          .filter(Boolean)
          .join(" | "),
      },
    ];
  },
});
