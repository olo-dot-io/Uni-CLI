import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { boolArg, intArg, js, str } from "../_shared/browser-tools.js";

function imageOutputPath(value: unknown): string {
  const raw = str(value, join(homedir(), "Pictures", "chatgpt"));
  return raw.replace(/^~(?=$|\/)/, homedir());
}

cli({
  site: "chatgpt",
  name: "image",
  description:
    "Generate an image in ChatGPT web and optionally save visible images",
  domain: "chatgpt.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "prompt", type: "str", required: true, positional: true },
    { name: "op", type: "str", default: "~/Pictures/chatgpt" },
    { name: "sd", type: "bool", default: false },
    { name: "timeout", type: "int", default: 120 },
  ],
  columns: ["status", "file", "link"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const prompt = str(kwargs.prompt);
    await p.goto("https://chatgpt.com/new", { settleMs: 2500 });
    await p.click("#prompt-textarea, textarea, [contenteditable='true']");
    await p.insertText(`Create an image: ${prompt}`);
    await p.press("Enter");
    const timeout = intArg(kwargs.timeout, 120, 600);
    const deadline = Date.now() + timeout * 1000;
    let images: string[] = [];
    while (Date.now() < deadline) {
      await p.wait(2);
      images = (await p.evaluate(`(() => {
        return [...document.querySelectorAll('img')]
          .map((img) => img.currentSrc || img.src)
          .filter((url) => url && /^https?:/.test(url));
      })()`)) as string[];
      if (images.length > 0) break;
    }
    if (boolArg(kwargs.sd)) {
      return [
        {
          status: images.length ? "generated" : "pending",
          file: "",
          link: await p.url(),
        },
      ];
    }
    const output = imageOutputPath(kwargs.op);
    await mkdir(output, { recursive: true });
    const rows: Record<string, unknown>[] = [];
    for (const [index, url] of images.entries()) {
      const response = await fetch(url);
      const bytes = Buffer.from(await response.arrayBuffer());
      const name =
        basename(new URL(url).pathname) ||
        `chatgpt-${Date.now()}-${index + 1}.png`;
      const file = join(output, `${Date.now()}-${name}`);
      await writeFile(file, bytes);
      rows.push({
        status: "saved",
        file,
        link: await p.url(),
        bytes: bytes.length,
      });
    }
    if (rows.length === 0) {
      rows.push({
        status: "no_image_found",
        file: "",
        link: await p.url(),
        prompt: js(prompt),
      });
    }
    return rows;
  },
});
