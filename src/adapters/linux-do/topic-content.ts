import { cli, Strategy } from "../../registry.js";
import { htmlToMarkdown } from "../../engine/html-to-markdown.js";
import type { IPage } from "../../types.js";
import { fetchLinuxDoJson } from "./browser-json.js";
import "./site.js";

interface TopicPost {
  raw?: string;
  cooked?: string;
  username?: string;
  created_at?: string;
}

interface TopicResponse {
  title?: string;
  post_stream?: {
    posts?: TopicPost[];
  };
}

cli({
  site: "linux-do",
  name: "topic-content",
  description: "Read the main Linux.do topic body as Markdown",
  domain: "linux.do",
  strategy: Strategy.COOKIE,
  browser: true,
  auth_requirement: "required",
  target_surface: "web",
  operation_effect: "read",
  execution_operator: "browser-protocol",
  operation_family: "get",
  idempotency: "guaranteed",
  capabilities: ["cdp-browser.navigate", "cdp-browser.evaluate"],
  minimum_capability: "cdp-browser.evaluate",
  args: [{ name: "id", type: "int", required: true, positional: true }],
  columns: ["title", "author", "content"],
  func: async (page, kwargs, context) => {
    const id = Number(kwargs.id);
    const data = (await fetchLinuxDoJson(
      page as IPage,
      `/t/${id}.json?include_raw=true`,
      context.signal,
    )) as TopicResponse;
    const first = data.post_stream?.posts?.[0] ?? {};
    return [
      {
        title: data.title ?? "",
        author: first.username ?? "",
        created_at: first.created_at ?? "",
        content: first.raw?.trim() || htmlToMarkdown(first.cooked ?? ""),
      },
    ];
  },
});
