/**
 * @owner   src/adapters/codex/projects.ts
 * @does    Register agent-facing Codex projects sidebar reader.
 * @needs   Codex Electron DOM sidebar markers, project filtering, bounded conversation flattening.
 * @feeds   surface coverage ledger, Codex project inventory workflows, visible thread selection context.
 * @breaks  Codex sidebar DOM marker drift or weak filtering can hide visible projects.
 */

import { cli, Strategy } from "../../registry.js";
import { connectElectronApp } from "../_electron/shared.js";

interface CodexConversation {
  index: number;
  title: string;
  updated: string;
  active: boolean;
  threadId: string;
}

interface CodexProject {
  project: string;
  projectPath: string;
  collapsed: boolean;
  conversations: CodexConversation[];
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalized(value: unknown): string {
  return cleanText(value).toLowerCase();
}

function matchesProject(project: CodexProject, query: unknown): boolean {
  const needle = normalized(query);
  if (!needle) return true;
  const label = normalized(project.project);
  const projectPath = normalized(project.projectPath);
  return (
    label === needle ||
    label.includes(needle) ||
    projectPath === needle ||
    projectPath.endsWith(`/${needle}`)
  );
}

export function parseCodexProjectLimit(value: unknown): number | null {
  if (value === undefined || value === null || cleanText(value) === "")
    return null;
  const raw = cleanText(value);
  if (!/^\d+$/.test(raw))
    throw new Error("codex projects limit must be a positive integer.");
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error("codex projects limit must be a positive integer.");
  }
  return n;
}

export function flattenCodexProjectRows(
  projects: CodexProject[],
  options: { project?: unknown; limit?: unknown } = {},
): Array<Record<string, unknown>> {
  const limit = parseCodexProjectLimit(options.limit);
  const rows: Array<Record<string, unknown>> = [];
  for (const project of projects) {
    if (!matchesProject(project, options.project)) continue;
    const conversations = limit
      ? project.conversations.slice(0, limit)
      : project.conversations;
    if (conversations.length === 0) {
      rows.push({
        Project: project.project,
        Index: 0,
        Title: project.collapsed ? "(collapsed)" : "(no visible conversations)",
        Updated: "",
        Active: "",
        ProjectPath: project.projectPath,
        ThreadId: "",
      });
      continue;
    }
    for (const conversation of conversations) {
      rows.push({
        Project: project.project,
        Index: conversation.index,
        Title: conversation.title,
        Updated: conversation.updated,
        Active: conversation.active ? "yes" : "",
        ProjectPath: project.projectPath,
        ThreadId: conversation.threadId,
      });
    }
  }
  return rows;
}

function collectCodexProjectsScript(): string {
  return `(() => {
    const projectRows = Array.from(document.querySelectorAll('[data-app-action-sidebar-project-row]'));
    const visibleText = (el) => (el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const isRelativeTime = (text) => /^(?:(?:\\d+\\s*)?(?:刚刚|秒|分钟|小时|天|周|个月|年|sec|min|hr|hour|day|week|month|year|s|m|h|d|w)|.*\\bago)$/i.test(String(text || '').trim());
    const updatedText = (row, title) => {
      const candidates = Array.from(row.querySelectorAll('.tabular-nums, [class*="tabular-nums"], [class*="description"]')).map(visibleText).filter(Boolean);
      const direct = candidates.find(isRelativeTime);
      if (direct) return direct;
      const suffix = visibleText(row).replace(title, '').trim();
      return isRelativeTime(suffix) ? suffix : '';
    };
    return projectRows.map((projectRow, projectIndex) => {
      const project = projectRow.getAttribute('data-app-action-sidebar-project-label') || projectRow.getAttribute('aria-label') || visibleText(projectRow);
      const projectPath = projectRow.getAttribute('data-app-action-sidebar-project-id') || '';
      const projectItem = projectRow.closest('[role="listitem"][aria-label]') || projectRow.parentElement;
      const threadRows = projectItem ? Array.from(projectItem.querySelectorAll('[data-app-action-sidebar-thread-row]')) : [];
      return {
        index: projectIndex + 1,
        project,
        projectPath,
        collapsed: projectRow.getAttribute('data-app-action-sidebar-project-collapsed') === 'true' || projectRow.getAttribute('aria-expanded') === 'false',
        conversations: threadRows.map((row, index) => {
          const title = row.getAttribute('data-app-action-sidebar-thread-title') || visibleText(row);
          return {
            index: index + 1,
            title,
            updated: updatedText(row, title),
            active: row.getAttribute('data-app-action-sidebar-thread-active') === 'true',
            threadId: row.getAttribute('data-app-action-sidebar-thread-id') || ''
          };
        })
      };
    });
  })()`;
}

cli({
  site: "codex",
  name: "projects",
  description: "List Codex projects and visible conversations from the sidebar",
  domain: "localhost",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "project",
      type: "str",
      description: "Filter by project label or path",
    },
    {
      name: "limit",
      type: "int",
      description: "Max conversations per project",
    },
  ],
  columns: ["Project", "Index", "Title", "Updated", "Active"],
  func: async (_page, kwargs) => {
    const page = await connectElectronApp("codex");
    const projects = (await page.evaluate(
      collectCodexProjectsScript(),
    )) as CodexProject[];
    if (!Array.isArray(projects)) {
      throw new Error(
        "Codex sidebar project extraction returned an invalid payload.",
      );
    }
    const rows = flattenCodexProjectRows(projects, kwargs);
    if (rows.length === 0) {
      throw new Error(
        kwargs.project
          ? `No Codex projects matched "${String(kwargs.project)}".`
          : "No Codex projects were visible.",
      );
    }
    return rows;
  },
});
