import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

type JsonRecord = Record<string, unknown>;

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function pageOf(page: unknown): IPage {
  if (!page) throw new Error("browser page required");
  return page as IPage;
}

function parseInput(input: unknown): {
  username: string;
  slug: string;
  url: string;
} {
  const raw = str(input).trim();
  if (!raw) throw new Error("input is required");
  const path = /^https?:\/\//i.test(raw) ? new URL(raw).pathname : raw;
  const [username, slug] = path.replace(/^\/+|\/+$/g, "").split("/");
  if (!username || !slug)
    throw new Error("expected Uiverse URL or author/slug");
  return { username, slug, url: `https://uiverse.io/${username}/${slug}` };
}

async function routeData(page: IPage, input: unknown): Promise<JsonRecord> {
  const parsed = parseInput(input);
  await page.goto(parsed.url);
  await page.wait(2);
  const raw = (await page.evaluate(`(async () => {
    const key = "routes/$username.$friendlyId";
    const loaderData = window.__remixContext?.state?.loaderData || {};
    let routeData = loaderData[key];
    if (!routeData?.post?.id) {
      const response = await fetch(location.pathname + "?_data=" + encodeURIComponent(key), {
        credentials: "include",
        headers: { accept: "application/json, text/plain, */*" }
      });
      routeData = await response.json();
    }
    return JSON.stringify(routeData || {});
  })()`)) as string;
  return { ...parsed, routeData: JSON.parse(raw) as JsonRecord };
}

async function rawCode(page: IPage, postId: unknown): Promise<JsonRecord> {
  const raw = (await page.evaluate(`(async () => {
    const key = "routes/resource.post.code.$id";
    const response = await fetch("/resource/post/code/${str(postId)}?v=1&_data=" + encodeURIComponent(key), {
      credentials: "include",
      headers: { accept: "application/json, text/plain, */*" }
    });
    return JSON.stringify(await response.json());
  })()`)) as string;
  return JSON.parse(raw) as JsonRecord;
}

cli({
  site: "uiverse",
  name: "code",
  description: "Uiverse component code export (HTML or CSS)",
  domain: "uiverse.io",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    {
      name: "input",
      type: "str",
      required: true,
      positional: true,
      description: "Uiverse URL or author/slug",
    },
    {
      name: "target",
      type: "str",
      default: "html",
      choices: ["html", "css"],
      description: "Code target",
    },
  ],
  columns: ["target", "username", "slug", "language", "length"],
  func: async (page, kwargs) => {
    const browser = pageOf(page);
    const detail = await routeData(browser, kwargs.input);
    const post = ((detail.routeData as JsonRecord).post ?? {}) as JsonRecord;
    const code = await rawCode(browser, post.id);
    const target = str(kwargs.target).toLowerCase() === "css" ? "css" : "html";
    const value = str(target === "css" ? code.css : code.html);
    return {
      target,
      username: detail.username,
      slug: detail.slug,
      url: detail.url,
      language: target,
      length: value.length,
      code: value,
      postId: post.id,
      type: post.type,
      isTailwind: Boolean(post.isTailwind),
    };
  },
});

cli({
  site: "uiverse",
  name: "preview",
  description: "Capture a Uiverse component preview screenshot",
  domain: "uiverse.io",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    {
      name: "input",
      type: "str",
      required: true,
      positional: true,
      description: "Uiverse URL or author/slug",
    },
    {
      name: "output",
      type: "str",
      default: "",
      description: "Output PNG path",
    },
  ],
  columns: ["username", "slug", "output", "bytes"],
  func: async (page, kwargs) => {
    const browser = pageOf(page);
    const detail = await routeData(browser, kwargs.input);
    const buffer = await browser.screenshot({ format: "png", fullPage: false });
    const output =
      str(kwargs.output) ||
      join(
        tmpdir(),
        "unicli-uiverse",
        `${str(detail.username)}-${str(detail.slug)}.png`,
      );
    await mkdir(output.split("/").slice(0, -1).join("/"), { recursive: true });
    await writeFile(output, buffer);
    return {
      username: detail.username,
      slug: detail.slug,
      url: detail.url,
      output,
      bytes: buffer.length,
    };
  },
});
