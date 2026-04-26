import TurndownService from "turndown";
import { cli, Strategy } from "../../registry.js";

interface TopicPost {
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
  strategy: Strategy.PUBLIC,
  args: [{ name: "id", type: "int", required: true, positional: true }],
  columns: ["title", "author", "content"],
  func: async (_page, kwargs) => {
    const id = Number(kwargs.id);
    const response = await fetch(`https://linux.do/t/${id}.json`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`linux-do topic request failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as TopicResponse;
    const first = data.post_stream?.posts?.[0] ?? {};
    const turndown = new TurndownService({ headingStyle: "atx" });
    return [
      {
        title: data.title ?? "",
        author: first.username ?? "",
        created_at: first.created_at ?? "",
        content: turndown.turndown(first.cooked ?? ""),
      },
    ];
  },
});
