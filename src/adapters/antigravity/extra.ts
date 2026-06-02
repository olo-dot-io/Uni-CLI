import { cli, Strategy } from "../../registry.js";
import {
  connectElectronApp,
  electronAppCommandMeta,
} from "../_electron/shared.js";
import { intArg } from "../_shared/browser-tools.js";

const ANTIGRAVITY_COMMAND_META = electronAppCommandMeta(
  "src/adapters/antigravity/extra.ts",
);

async function readAntigravityText(): Promise<string> {
  const page = await connectElectronApp("antigravity");
  const text = await page.evaluate("document.body?.innerText ?? ''");
  return String(text ?? "");
}

cli({
  site: "antigravity",
  name: "extract-code",
  description: "Extract code blocks from the active Antigravity conversation",
  strategy: Strategy.PUBLIC,
  ...ANTIGRAVITY_COMMAND_META,
  columns: ["language", "code"],
  func: async () => {
    const page = await connectElectronApp("antigravity");
    const blocks = (await page.evaluate(`(() => {
      return [...document.querySelectorAll('pre code, .cm-content, [class*="code"]')]
        .map((node) => ({
          language: [...node.classList].find((name) => name.startsWith('language-'))?.replace('language-', '') || '',
          code: (node.textContent || '').trim()
        })).filter((row) => row.code);
    })()`)) as Record<string, unknown>[];
    return blocks;
  },
});

cli({
  site: "antigravity",
  name: "watch",
  description: "Poll Antigravity conversation text for updates",
  strategy: Strategy.PUBLIC,
  ...ANTIGRAVITY_COMMAND_META,
  args: [
    { name: "interval", type: "int", default: 2 },
    { name: "iterations", type: "int", default: 5 },
  ],
  columns: ["iteration", "text"],
  func: async (_page, kwargs) => {
    const interval = intArg(kwargs.interval, 2, 60);
    const iterations = intArg(kwargs.iterations, 5, 500);
    const rows: Record<string, unknown>[] = [];
    let previous = "";
    for (let i = 0; i < iterations; i += 1) {
      const text = await readAntigravityText();
      if (text !== previous) rows.push({ iteration: i + 1, text });
      previous = text;
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
    return rows;
  },
});
