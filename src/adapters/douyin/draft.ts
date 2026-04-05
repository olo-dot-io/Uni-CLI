/**
 * Douyin draft — upload a video through the official creator page and save as draft.
 *
 * Drives the official upload page via browser automation so it stays
 * aligned with the site.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const VISIBILITY_LABELS: Record<string, string> = {
  public: "\u516c\u5f00",
  friends: "\u597d\u53cb\u53ef\u89c1",
  private: "\u4ec5\u81ea\u5df1\u53ef\u89c1",
};

const DRAFT_UPLOAD_URL =
  "https://creator.douyin.com/creator-micro/content/upload";

cli({
  site: "douyin",
  name: "draft",
  description: "Upload a video and save as draft on Douyin",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "video",
      required: true,
      positional: true,
      description: "Video file path",
    },
    {
      name: "title",
      required: true,
      description: "Video title (max 30 chars)",
    },
    { name: "caption", default: "", description: "Caption text (max 1000 chars)" },
    { name: "cover", default: "", description: "Cover image path" },
    {
      name: "visibility",
      default: "public",
      choices: ["public", "friends", "private"],
      description: "Visibility setting",
    },
  ],
  columns: ["status", "draft_id"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const videoPath = path.resolve(kwargs.video as string);
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }
    const ext = path.extname(videoPath).toLowerCase();
    if (![".mp4", ".mov", ".avi", ".webm"].includes(ext)) {
      throw new Error(
        `Unsupported video format: ${ext} (supported: mp4/mov/avi/webm)`,
      );
    }

    const title = kwargs.title as string;
    if (title.length > 30) throw new Error("Title must be <= 30 characters");

    const caption = (kwargs.caption as string) || "";
    if (caption.length > 1000)
      throw new Error("Caption must be <= 1000 characters");

    const visibilityLabel =
      VISIBILITY_LABELS[(kwargs.visibility as string) ?? "public"] ??
      VISIBILITY_LABELS.public;

    // Navigate and upload
    await p.goto(DRAFT_UPLOAD_URL);
    await p.waitForSelector('input[type="file"]', 20);

    // Dismiss known modals
    await p.evaluate(`() => {
      const targets = ['我知道了', '知道了', '关闭'];
      for (const text of targets) {
        const btn = Array.from(document.querySelectorAll('button,[role="button"]'))
          .find((el) => (el.textContent || '').trim() === text);
        if (btn instanceof HTMLElement) btn.click();
      }
    }`);

    await p.setFileInput('input[type="file"]', [videoPath]);

    // Wait for composer
    for (let attempt = 0; attempt < 120; attempt++) {
      const ready = (await p.evaluate(`() => ({
        ready: !!Array.from(document.querySelectorAll('input')).find(
          (el) => (el.placeholder || '').includes('填写作品标题')
        ) && !!Array.from(document.querySelectorAll('button')).find(
          (el) => (el.textContent || '').includes('暂存离开')
        )
      })`)) as { ready: boolean };
      if (ready.ready) break;
      await p.wait(0.5);
    }

    // Fill title via React props
    await p.evaluate(`() => {
      const titleInput = Array.from(document.querySelectorAll('input')).find(
        (el) => (el.placeholder || '').includes('填写作品标题')
      );
      if (!(titleInput instanceof HTMLInputElement)) return false;
      const propKey = Object.keys(titleInput).find((key) => key.startsWith('__reactProps$'));
      const props = propKey ? titleInput[propKey] : null;
      if (props?.onChange) {
        props.onChange({ target: { value: ${JSON.stringify(title)} }, currentTarget: { value: ${JSON.stringify(title)} } });
      } else {
        titleInput.focus();
        titleInput.value = ${JSON.stringify(title)};
        titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        titleInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }`);

    // Fill caption
    if (caption) {
      await p.evaluate(`() => {
        const editor = document.querySelector('[contenteditable="true"]');
        if (!(editor instanceof HTMLElement)) return false;
        editor.focus();
        editor.textContent = '';
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, ${JSON.stringify(caption)});
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }`);
    }

    // Set visibility
    await p.evaluate(`() => {
      const visibility = Array.from(document.querySelectorAll('label')).find(
        (el) => (el.textContent || '').includes(${JSON.stringify(visibilityLabel)})
      );
      if (visibility instanceof HTMLElement) visibility.click();
    }`);

    // Upload cover if provided
    if (kwargs.cover) {
      const coverPath = path.resolve(kwargs.cover as string);
      if (!fs.existsSync(coverPath)) {
        throw new Error(`Cover file not found: ${coverPath}`);
      }
      // Click "upload new cover" label
      await p.evaluate(`() => {
        const coverLabel = Array.from(document.querySelectorAll('label')).find(
          (el) => (el.textContent || '').includes('上传新封面')
        );
        if (coverLabel instanceof HTMLElement) coverLabel.click();
      }`);
      await p.wait(1);

      // Find and inject cover file
      const coverInputs = (await p.evaluate(
        `() => Array.from(document.querySelectorAll('input[type="file"]')).length`,
      )) as number;
      if (coverInputs > 1) {
        // Use the last file input (likely the cover one)
        await p.setFileInput(
          'input[type="file"]:last-of-type',
          [coverPath],
        );
        await p.wait(3);
      }
    }

    await p.wait(1);

    // Click save draft button
    const saveResult = (await p.evaluate(`() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (el) => (el.textContent || '').includes('暂存离开')
      );
      if (!(btn instanceof HTMLButtonElement)) return { ok: false };
      btn.click();
      return { ok: true };
    }`)) as { ok: boolean };

    if (!saveResult.ok) {
      throw new Error("Could not find draft save button");
    }

    // Wait for confirmation
    await p.wait(3);

    return [
      {
        status: "Draft saved — continue editing in creator center",
        draft_id: title,
      },
    ];
  },
});
