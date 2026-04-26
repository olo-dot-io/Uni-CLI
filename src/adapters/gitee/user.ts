import { cli, Strategy } from "../../registry.js";
import { str } from "../_shared/browser-tools.js";

function textBetween(html: string, pattern: RegExp): string {
  return (pattern.exec(html)?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

cli({
  site: "gitee",
  name: "user",
  description: "Show public Gitee user profile information",
  domain: "gitee.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "username", type: "str", required: true, positional: true }],
  columns: ["username", "name", "followers", "public_repos", "url"],
  func: async (_page, kwargs) => {
    const username = str(kwargs.username);
    const response = await fetch(
      `https://gitee.com/api/v5/users/${encodeURIComponent(username)}`,
    );
    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      return [
        {
          username: data.login ?? username,
          name: data.name ?? "",
          followers: data.followers ?? 0,
          public_repos: data.public_repos ?? 0,
          url: data.html_url ?? `https://gitee.com/${username}`,
        },
      ];
    }

    const url = `https://gitee.com/${encodeURIComponent(username)}`;
    const htmlResponse = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; Uni-CLI)" },
    });
    if (!htmlResponse.ok) {
      throw new Error(`Gitee user request failed: HTTP ${htmlResponse.status}`);
    }
    const html = await htmlResponse.text();
    const name =
      textBetween(html, /<title>(.*?)<\/title>/is).split(" - ")[0] || username;
    const followers = textBetween(html, /关注者[^0-9]*(\d+)/i);
    const repos = textBetween(html, /仓库[^0-9]*(\d+)/i);
    return [
      {
        username,
        name,
        followers,
        public_repos: repos,
        url,
      },
    ];
  },
});
