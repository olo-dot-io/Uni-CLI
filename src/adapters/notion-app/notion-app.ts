/**
 * Notion desktop app adapter -- workspace navigation + page read/write.
 *
 * Notion doesn't follow the AI chat pattern, so commands are registered manually.
 * Note: site name is "notion" (matching electron-apps.ts), directory is notion-app/.
 *
 * Commands: search, read, write, new, status, sidebar, favorites, export, screenshot
 */

import { connectElectronApp } from "../_electron/shared.js";
import { cli, Strategy } from "../../registry.js";

// search -- Quick-find via Cmd+K
cli({
  site: "notion",
  name: "search",
  description: "Search in Notion (Cmd+K)",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      required: true,
      positional: true,
      description: "Search query",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const p = await connectElectronApp("notion");
    await p.press("k", ["meta"]);
    await p.wait(0.5);
    await p.insertText(String(kwargs.query));
    await p.wait(1);
    const results = await p.evaluate(`
      (() => {
        const items = document.querySelectorAll(
          '.notion-search-menu .notion-search-item, [role="listbox"] [role="option"]'
        );
        return Array.from(items).slice(0, 10).map(el => ({
          title: el.textContent?.trim()?.slice(0, 100),
        }));
      })()
    `);
    return results as unknown[];
  },
});

// read -- Read current page content
cli({
  site: "notion",
  name: "read",
  description: "Read current Notion page content",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("notion");
    const content = await p.evaluate(`
      document.querySelector('.notion-page-content, .notion-frame .notion-scroller')
        ?.innerText?.slice(0, 10000) ?? ''
    `);
    return [{ content }];
  },
});

// write -- Append text to current page
cli({
  site: "notion",
  name: "write",
  description: "Append text to current Notion page",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "text",
      required: true,
      positional: true,
      description: "Text to append",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const p = await connectElectronApp("notion");
    await p.evaluate(`
      (() => {
        const blocks = document.querySelectorAll('.notion-page-content [contenteditable]');
        const last = blocks[blocks.length - 1];
        if (last) last.click();
      })()
    `);
    await p.wait(0.3);
    await p.press("End");
    await p.press("Enter");
    await p.insertText(String(kwargs.text));
    return [{ ok: true }];
  },
});

// new -- Create new page
cli({
  site: "notion",
  name: "new",
  description: "Create new Notion page",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "title",
      required: false,
      positional: true,
      default: "Untitled",
      description: "Page title",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const p = await connectElectronApp("notion");
    await p.press("n", ["meta"]);
    await p.wait(1);
    await p.insertText(String(kwargs.title ?? "Untitled"));
    return [{ ok: true }];
  },
});

// status -- Workspace status
cli({
  site: "notion",
  name: "status",
  description: "Notion workspace status",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("notion");
    const title = await p.title();
    return [{ app: "Notion", title }];
  },
});

// sidebar -- Read sidebar navigation
cli({
  site: "notion",
  name: "sidebar",
  description: "Read Notion sidebar navigation",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("notion");
    const items = await p.evaluate(`
      (() => {
        const nodes = document.querySelectorAll(
          '.notion-sidebar .notion-sidebar-item, [role="treeitem"]'
        );
        return Array.from(nodes).slice(0, 30).map(n => ({
          title: n.textContent?.trim()?.slice(0, 80),
        }));
      })()
    `);
    return items as unknown[];
  },
});

// favorites -- List favorites
cli({
  site: "notion",
  name: "favorites",
  description: "List Notion favorites",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("notion");
    const items = await p.evaluate(`
      (() => {
        const section = document.querySelector(
          '.notion-sidebar [data-testid="favorites-section"], .notion-sidebar-favorites'
        );
        if (!section) return [];
        const nodes = section.querySelectorAll('[role="treeitem"], .notion-sidebar-item');
        return Array.from(nodes).map(n => ({
          title: n.textContent?.trim()?.slice(0, 80),
        }));
      })()
    `);
    return items as unknown[];
  },
});

// export -- Export current page as markdown
cli({
  site: "notion",
  name: "export",
  description: "Export current Notion page as markdown",
  strategy: Strategy.PUBLIC,
  func: async () => {
    const p = await connectElectronApp("notion");
    const content = await p.evaluate(`
      document.querySelector('.notion-page-content')?.innerText ?? ''
    `);
    return [{ markdown: content }];
  },
});

// screenshot -- Capture current page
cli({
  site: "notion",
  name: "screenshot",
  description: "Screenshot current Notion page",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "path",
      required: false,
      positional: true,
      default: "./notion-screenshot.png",
      description: "Output file path",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const p = await connectElectronApp("notion");
    const filePath = String(kwargs.path ?? "./notion-screenshot.png");
    const buf = await p.screenshot({ path: filePath, format: "png" });
    return [{ path: filePath, size: buf.length }];
  },
});
