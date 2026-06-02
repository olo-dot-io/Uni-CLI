import { cli, Strategy } from "../../registry.js";
import {
  connectElectronApp,
  electronAppCommandMeta,
} from "../_electron/shared.js";
import { intArg } from "../_shared/browser-tools.js";

const CHATWISE_COMMAND_META = electronAppCommandMeta(
  "src/adapters/chatwise/extra.ts",
);

cli({
  site: "chatwise",
  name: "history",
  description: "List ChatWise conversations from the sidebar",
  strategy: Strategy.PUBLIC,
  ...CHATWISE_COMMAND_META,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title"],
  func: async (_page, kwargs) => {
    const page = await connectElectronApp("chatwise");
    const limit = intArg(kwargs.limit, 20, 100);
    const rows = (await page.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[class*="conversation"], [class*="chat"], [role="listitem"], a')];
      return nodes.map((node) => ({
        title: (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
      })).filter((row) => row.title).slice(0, ${limit});
    })()`)) as Record<string, unknown>[];
    return rows;
  },
});

cli({
  site: "chatwise",
  name: "export",
  description: "Export the current ChatWise conversation as Markdown text",
  strategy: Strategy.PUBLIC,
  ...CHATWISE_COMMAND_META,
  columns: ["content"],
  func: async () => {
    const page = await connectElectronApp("chatwise");
    const text = await page.evaluate("document.body?.innerText ?? ''");
    return [{ content: String(text ?? "").trim() }];
  },
});
