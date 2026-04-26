import { cli, Strategy } from "../../registry.js";
import { connectElectronApp } from "../_electron/shared.js";
import { intArg } from "../_shared/browser-tools.js";

cli({
  site: "codex",
  name: "history",
  description: "List Codex desktop conversation threads",
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title"],
  func: async (_page, kwargs) => {
    const page = await connectElectronApp("codex");
    const limit = intArg(kwargs.limit, 20, 100);
    const rows = (await page.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[class*="thread"], [class*="conversation"], [role="listitem"], a')];
      return nodes.map((node) => ({
        title: (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
      })).filter((row) => row.title).slice(0, ${limit});
    })()`)) as Record<string, unknown>[];
    return rows;
  },
});

cli({
  site: "codex",
  name: "export",
  description: "Export the current Codex desktop thread as Markdown text",
  strategy: Strategy.PUBLIC,
  columns: ["content"],
  func: async () => {
    const page = await connectElectronApp("codex");
    const text = await page.evaluate("document.body?.innerText ?? ''");
    return [{ content: String(text ?? "").trim() }];
  },
});
