/**
 * @owner   bench/product-surface.ts
 * @does    Measure user-visible discovery, actionability, personalized content, catalog synchronization, and current competitor surface snapshots.
 * @needs   built Uni-CLI dist, generated docs/site-index.json, pinned OpenCLI manifest, bench/product-baselines.json
 * @feeds   bench/product-surface-results.json and generated product sections in docs/BENCHMARK.md plus docs/zh/BENCHMARK.md
 * @breaks  Exits nonzero when a user task, actionability field, catalog synchronization check, or declared parity gate fails.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

import { metadataAuthRequirement } from "../src/core/auth-contract.js";
import {
  classifyPersonalization,
  type PersonalizationFamily,
} from "../src/discovery/personalization.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "main.js");
const MANIFEST_PATH = join(REPO_ROOT, "dist", "manifest.json");
const SITE_INDEX_PATH = join(REPO_ROOT, "docs", "site-index.json");
const OPENCLI_MANIFEST_PATH = join(
  REPO_ROOT,
  "ref",
  "agent-control-plane",
  "opencli",
  "cli-manifest.json",
);
const BASELINES_PATH = join(HERE, "product-baselines.json");
const RESULTS_PATH = join(HERE, "product-surface-results.json");
const ENGLISH_DOC = join(REPO_ROOT, "docs", "BENCHMARK.md");
const CHINESE_DOC = join(REPO_ROOT, "docs", "zh", "BENCHMARK.md");
const BEGIN_MARKER = "<!-- PRODUCT-SURFACE:begin -->";
const END_MARKER = "<!-- PRODUCT-SURFACE:end -->";

interface SearchTask {
  id: string;
  intent: string;
  expected: string;
  personalized?: boolean;
  family?: PersonalizationFamily;
}

interface SearchRow {
  command?: string;
  usage?: string;
  inspect?: string;
  auth?: "required" | "optional" | "none";
  auth_setup?: string;
  personalization?: PersonalizationFamily;
}

interface ManifestCommand {
  name: string;
  description?: string;
  strategy?: string;
  capabilities?: string[];
  auth_requirement?: "required" | "optional" | "none";
}

interface ManifestSite {
  category?: string;
  commands: ManifestCommand[];
}

interface Manifest {
  sites: Record<string, ManifestSite>;
}

interface SiteIndex {
  sites: Array<{
    site: string;
    command_count: number;
    personalized_commands_count?: number;
    commands: Array<{ command: string; personalization?: string }>;
  }>;
}

interface OpenCliCommand {
  site: string;
  name: string;
  description?: string;
  strategy?: string;
}

interface Baselines {
  captured_at: string;
  opencli: {
    repository: string;
    commit: string;
    commit_date: string;
    package_version: string;
    catalog: { sites: number; commands: number };
    declared_boundary: string;
    evidence: string[];
  };
  cli_anything: {
    repository: string;
    commit: string;
    commit_date: string;
    catalog: {
      harness_clis: number;
      public_cli_entries: number;
      matrices: number;
      matrix_capabilities: number;
    };
    declared_boundary: string;
    evidence: string[];
  };
}

const TASKS: readonly SearchTask[] = [
  {
    id: "news-top",
    intent: "hackernews top stories",
    expected: "hackernews top",
  },
  {
    id: "developer-trending",
    intent: "github trending today",
    expected: "github-trending daily",
  },
  {
    id: "developer-code-search",
    intent: "search github code for token",
    expected: "gh search-code",
  },
  {
    id: "media-playback",
    intent: "play music on spotify",
    expected: "spotify play-track",
  },
  {
    id: "auth-setup",
    intent: "setup login cookies for twitter",
    expected: "auth setup",
  },
  {
    id: "cli-upgrade",
    intent: "update old Uni-CLI version for agent",
    expected: "upgrade install",
  },
  {
    id: "xiaohongshu-saved",
    intent: "my saved Xiaohongshu notes",
    expected: "xiaohongshu saved",
    personalized: true,
    family: "library",
  },
  {
    id: "instagram-saved",
    intent: "my saved Instagram posts",
    expected: "instagram saved",
    personalized: true,
    family: "library",
  },
  {
    id: "zhihu-recommendations",
    intent: "Zhihu personalized recommendations",
    expected: "zhihu recommend",
    personalized: true,
    family: "feed",
  },
  {
    id: "twitter-notifications",
    intent: "Twitter notifications",
    expected: "twitter notifications",
    personalized: true,
    family: "activity",
  },
  {
    id: "bilibili-history",
    intent: "Bilibili watch history",
    expected: "bilibili history",
    personalized: true,
    family: "library",
  },
] as const;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function runCli(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      UNICLI_SKIP_UPDATE_CHECK: "1",
    },
  });
  return { status: result.status, stdout: result.stdout };
}

function searchTask(task: SearchTask): Record<string, unknown> {
  const args = ["search", task.intent, "--limit", "5"];
  if (task.personalized) args.push("--personalized");
  args.push("-f", "json");
  const run = runCli(args);
  let rows: SearchRow[] = [];
  try {
    const envelope = JSON.parse(run.stdout) as { data?: SearchRow[] };
    rows = envelope.data ?? [];
  } catch {
    rows = [];
  }
  const top = rows[0];
  const top1 = run.status === 0 && top?.command === task.expected;
  const actionable =
    typeof top?.usage === "string" &&
    top.usage.startsWith("unicli ") &&
    typeof top?.inspect === "string" &&
    top.inspect.startsWith("unicli describe ") &&
    (top.auth !== "required" ||
      (typeof top.auth_setup === "string" && top.auth_setup.length > 0));
  const familyMatch = !task.family || top?.personalization === task.family;
  return {
    id: task.id,
    intent: task.intent,
    expected: task.expected,
    top1: top?.command ?? null,
    top1_ok: top1,
    actionable,
    family: top?.personalization ?? null,
    family_ok: familyMatch,
    usage: top?.usage ?? null,
    inspect: top?.inspect ?? null,
    auth: top?.auth ?? null,
    auth_setup: top?.auth_setup ?? null,
  };
}

function personalizedContentCounts(manifest: Manifest): {
  commands: number;
  sites: number;
  families: Record<string, number>;
} {
  const rows: Array<{ site: string; family: PersonalizationFamily }> = [];
  for (const [site, info] of Object.entries(manifest.sites)) {
    for (const command of info.commands) {
      const family = classifyPersonalization({
        command: command.name,
        description: command.description,
        category: info.category,
        auth: metadataAuthRequirement(
          command.strategy,
          command.capabilities,
          command.auth_requirement,
        ),
      });
      if (family && family !== "account") rows.push({ site, family });
    }
  }
  return countPersonalizedRows(rows);
}

function openCliPersonalizedContentCounts(
  commands: OpenCliCommand[],
): ReturnType<typeof personalizedContentCounts> {
  const rows: Array<{ site: string; family: PersonalizationFamily }> = [];
  for (const command of commands) {
    const auth = ["cookie", "browser"].includes(command.strategy ?? "")
      ? "required"
      : "none";
    const family = classifyPersonalization({
      command: command.name,
      description: command.description,
      auth,
    });
    if (family && family !== "account") {
      rows.push({ site: command.site, family });
    }
  }
  return countPersonalizedRows(rows);
}

function countPersonalizedRows(
  rows: Array<{ site: string; family: PersonalizationFamily }>,
): { commands: number; sites: number; families: Record<string, number> } {
  const families: Record<string, number> = {};
  for (const row of rows) {
    families[row.family] = (families[row.family] ?? 0) + 1;
  }
  return {
    commands: rows.length,
    sites: new Set(rows.map((row) => row.site)).size,
    families,
  };
}

async function patchDocument(path: string, section: string): Promise<void> {
  const source = readFileSync(path, "utf8");
  const begin = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`${path} is missing product surface markers`);
  }
  const next = `${source.slice(0, begin)}${section}${source.slice(end + END_MARKER.length)}`;
  writeFileSync(path, await format(next, { parser: "markdown" }));
}

function pct(numerator: number, denominator: number): string {
  return `${((numerator / Math.max(1, denominator)) * 100).toFixed(1)}%`;
}

function renderEnglish(report: ProductSurfaceReport): string {
  const lines = [
    BEGIN_MARKER,
    "",
    "## Current product surface comparison",
    "",
    "The comparison keeps each product inside its declared boundary. Catalog totals measure breadth. The Uni-CLI task suite measures whether a user can find and prepare an operation from the shipped command line.",
    "",
    "| Product | Source revision | Declared surface | Current scale |",
    "|---|---|---|---|",
    `| Uni-CLI | working tree on ${report.generated_at.slice(0, 10)} | web, browser, desktop, system, and local tools | ${report.uni.catalog.sites} sites and ${report.uni.catalog.commands} commands |`,
    `| [OpenCLI](${report.sources.opencli.repository}) | [${report.sources.opencli.commit.slice(0, 7)}](${report.sources.opencli.evidence[1]}) | website and browser adapter runtime | ${report.opencli.catalog.sites} sites and ${report.opencli.catalog.commands} commands |`,
    `| [CLI-Anything](${report.sources.cli_anything.repository}) | [${report.sources.cli_anything.commit.slice(0, 7)}](${report.sources.cli_anything.evidence[1]}) | stateful harnesses and capability matrices | ${report.cli_anything.catalog.harness_clis} harnesses, ${report.cli_anything.catalog.public_cli_entries} public entries, ${report.cli_anything.catalog.matrices} matrices, and ${report.cli_anything.catalog.matrix_capabilities} matrix capabilities |`,
    "",
    "The shared personal-content classifier omits generic identity commands such as `whoami`. Uni-CLI exposes more matching content commands. OpenCLI currently spans more matching sites.",
    "",
    "| Personal content surface | Uni-CLI | OpenCLI |",
    "|---|---|---|",
    `| commands | ${report.uni.personal_content.commands} | ${report.opencli.personal_content.commands} |`,
    `| sites | ${report.uni.personal_content.sites} | ${report.opencli.personal_content.sites} |`,
    "",
    "### Shipped discovery tasks",
    "",
    `Uni-CLI completed ${report.tasks.passed}/${report.tasks.total} tasks at rank one. ${report.tasks.actionable}/${report.tasks.total} top results included an invocation, inspection command, and required authentication setup. Personalized tasks completed ${report.tasks.personalized_passed}/${report.tasks.personalized_total}.`,
    "",
    "| Task | Expected | Top result | Actionable |",
    "|---|---|---|---|",
    ...report.task_results.map(
      (row) =>
        `| ${row.id} | \`${row.expected}\` | \`${row.top1 ?? "none"}\` | ${row.actionable && row.top1_ok && row.family_ok ? "yes" : "no"} |`,
    ),
    "",
    "### Maintenance gates",
    "",
    `- Root discovery entry coverage  ${report.uni.root_discovery.passed}/${report.uni.root_discovery.total}`,
    `- Generated catalog synchronization  ${report.uni.catalog.generated_catalog_in_sync ? "pass" : "fail"}`,
    `- OpenCLI pinned manifest synchronization  ${report.opencli.snapshot_in_sync ? "pass" : "fail"}`,
    `- Personal content command parity  ${report.gates.personal_content_command_parity ? "pass" : "fail"}`,
    `- Product surface gate  ${report.passed ? "pass" : "fail"}`,
    "",
    "Reproduce this section with `npm run bench:product-surface`.",
    "",
    END_MARKER,
  ];
  return lines.join("\n");
}

function renderChinese(report: ProductSurfaceReport): string {
  const lines = [
    BEGIN_MARKER,
    "",
    "## 当前产品能力对照",
    "",
    "这组数据按各项目公开声明的范围对照。目录数量用于观察覆盖面。Uni-CLI 任务集验证用户能否从已发布命令行找到操作并准备执行。",
    "",
    "| 产品 | 源码版本 | 公开范围 | 当前规模 |",
    "|---|---|---|---|",
    `| Uni-CLI | ${report.generated_at.slice(0, 10)} 工作区 | 网站、浏览器、桌面、系统和本地工具 | ${report.uni.catalog.sites} 个网站，${report.uni.catalog.commands} 条命令 |`,
    `| [OpenCLI](${report.sources.opencli.repository}) | [${report.sources.opencli.commit.slice(0, 7)}](${report.sources.opencli.evidence[1]}) | 网站和浏览器 adapter runtime | ${report.opencli.catalog.sites} 个网站，${report.opencli.catalog.commands} 条命令 |`,
    `| [CLI-Anything](${report.sources.cli_anything.repository}) | [${report.sources.cli_anything.commit.slice(0, 7)}](${report.sources.cli_anything.evidence[1]}) | 有状态 harness 和能力矩阵 | ${report.cli_anything.catalog.harness_clis} 个 harness，${report.cli_anything.catalog.public_cli_entries} 个公开入口，${report.cli_anything.catalog.matrices} 个矩阵，${report.cli_anything.catalog.matrix_capabilities} 项矩阵能力 |`,
    "",
    "统一的个人内容分类会略过 `whoami` 这类身份查询。Uni-CLI 的个人内容命令数量更多，OpenCLI 覆盖的网站数量更多。",
    "",
    "| 个人内容范围 | Uni-CLI | OpenCLI |",
    "|---|---|---|",
    `| 命令 | ${report.uni.personal_content.commands} | ${report.opencli.personal_content.commands} |`,
    `| 网站 | ${report.uni.personal_content.sites} | ${report.opencli.personal_content.sites} |`,
    "",
    "### 已发布发现任务",
    "",
    `Uni-CLI 有 ${report.tasks.passed}/${report.tasks.total} 个任务排在首位。${report.tasks.actionable}/${report.tasks.total} 个首位结果同时带有运行命令、参数查看命令和所需认证设置。个性化任务通过 ${report.tasks.personalized_passed}/${report.tasks.personalized_total} 个。`,
    "",
    "| 任务 | 预期命令 | 首位结果 | 可直接准备 |",
    "|---|---|---|---|",
    ...report.task_results.map(
      (row) =>
        `| ${row.id} | \`${row.expected}\` | \`${row.top1 ?? "无"}\` | ${row.actionable && row.top1_ok && row.family_ok ? "是" : "否"} |`,
    ),
    "",
    "### 维护检查",
    "",
    `- 根命令发现入口  ${report.uni.root_discovery.passed}/${report.uni.root_discovery.total}`,
    `- 生成目录同步  ${report.uni.catalog.generated_catalog_in_sync ? "通过" : "失败"}`,
    `- OpenCLI 固定 manifest 同步  ${report.opencli.snapshot_in_sync ? "通过" : "失败"}`,
    `- 个人内容命令对等检查  ${report.gates.personal_content_command_parity ? "通过" : "失败"}`,
    `- 产品能力检查  ${report.passed ? "通过" : "失败"}`,
    "",
    "运行 `npm run bench:product-surface` 可以重新生成本节。",
    "",
    END_MARKER,
  ];
  return lines.join("\n");
}

interface TaskResult {
  id: string;
  expected: string;
  top1: string | null;
  top1_ok: boolean;
  actionable: boolean;
  family_ok: boolean;
  [key: string]: unknown;
}

interface ProductSurfaceReport {
  generated_at: string;
  passed: boolean;
  sources: Baselines;
  uni: {
    catalog: {
      sites: number;
      commands: number;
      generated_catalog_in_sync: boolean;
    };
    personal_content: ReturnType<typeof personalizedContentCounts>;
    root_discovery: { passed: number; total: number; entries: string[] };
  };
  opencli: {
    catalog: { sites: number; commands: number };
    personal_content: ReturnType<typeof personalizedContentCounts>;
    snapshot_in_sync: boolean;
  };
  cli_anything: Baselines["cli_anything"];
  tasks: {
    total: number;
    passed: number;
    actionable: number;
    personalized_total: number;
    personalized_passed: number;
    top1_accuracy: string;
  };
  task_results: TaskResult[];
  gates: {
    catalog_breadth_parity: boolean;
    personal_content_command_parity: boolean;
    task_completion: boolean;
    actionability: boolean;
    personalized_task_completion: boolean;
    generated_catalog_sync: boolean;
  };
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  for (const path of [
    CLI_ENTRY,
    MANIFEST_PATH,
    SITE_INDEX_PATH,
    OPENCLI_MANIFEST_PATH,
    BASELINES_PATH,
  ]) {
    if (!existsSync(path)) throw new Error(`missing benchmark input ${path}`);
  }

  const baselines = readJson<Baselines>(BASELINES_PATH);
  const manifest = readJson<Manifest>(MANIFEST_PATH);
  const siteIndex = readJson<SiteIndex>(SITE_INDEX_PATH);
  const openCliCommands = readJson<OpenCliCommand[]>(OPENCLI_MANIFEST_PATH);
  const taskResults = TASKS.map(searchTask) as TaskResult[];

  const uniSites = Object.keys(manifest.sites).length;
  const uniCommands = Object.values(manifest.sites).reduce(
    (count, site) => count + site.commands.length,
    0,
  );
  const generatedCommands = siteIndex.sites.reduce(
    (count, site) => count + site.commands.length,
    0,
  );
  const generatedCatalogInSync =
    siteIndex.sites.length === uniSites && generatedCommands === uniCommands;
  const openCliSites = new Set(openCliCommands.map((row) => row.site)).size;
  const openCliSnapshotInSync =
    openCliSites === baselines.opencli.catalog.sites &&
    openCliCommands.length === baselines.opencli.catalog.commands;
  const uniPersonal = personalizedContentCounts(manifest);
  const openCliPersonal = openCliPersonalizedContentCounts(openCliCommands);

  const help = runCli(["--help"]);
  const rootEntries = [
    "search <intent",
    "do <goal",
    "list [",
    "describe [",
    "upgrade ",
  ];
  const rootDiscoveryPassed = rootEntries.filter((entry) =>
    help.stdout.includes(entry),
  ).length;
  const personalizedTasks = TASKS.filter((task) => task.personalized);
  const passedTasks = taskResults.filter(
    (row) => row.top1_ok && row.family_ok,
  ).length;
  const actionableTasks = taskResults.filter((row) => row.actionable).length;
  const personalizedPassed = taskResults.filter(
    (row) =>
      personalizedTasks.some((task) => task.id === row.id) &&
      row.top1_ok &&
      row.family_ok,
  ).length;

  const gates = {
    catalog_breadth_parity:
      uniSites >= openCliSites && uniCommands >= openCliCommands.length,
    personal_content_command_parity:
      uniPersonal.commands >= openCliPersonal.commands,
    task_completion: passedTasks === TASKS.length,
    actionability: actionableTasks === TASKS.length,
    personalized_task_completion:
      personalizedPassed === personalizedTasks.length,
    generated_catalog_sync: generatedCatalogInSync,
  };
  const passed =
    Object.values(gates).every(Boolean) &&
    rootDiscoveryPassed === rootEntries.length &&
    openCliSnapshotInSync;

  const report: ProductSurfaceReport = {
    generated_at: new Date().toISOString(),
    passed,
    sources: baselines,
    uni: {
      catalog: {
        sites: uniSites,
        commands: uniCommands,
        generated_catalog_in_sync: generatedCatalogInSync,
      },
      personal_content: uniPersonal,
      root_discovery: {
        passed: rootDiscoveryPassed,
        total: rootEntries.length,
        entries: rootEntries,
      },
    },
    opencli: {
      catalog: { sites: openCliSites, commands: openCliCommands.length },
      personal_content: openCliPersonal,
      snapshot_in_sync: openCliSnapshotInSync,
    },
    cli_anything: baselines.cli_anything,
    tasks: {
      total: TASKS.length,
      passed: passedTasks,
      actionable: actionableTasks,
      personalized_total: personalizedTasks.length,
      personalized_passed: personalizedPassed,
      top1_accuracy: pct(passedTasks, TASKS.length),
    },
    task_results: taskResults,
    gates,
  };

  if (!checkOnly) {
    writeFileSync(
      RESULTS_PATH,
      await format(JSON.stringify(report), { parser: "json" }),
    );
    await patchDocument(ENGLISH_DOC, renderEnglish(report));
    await patchDocument(CHINESE_DOC, renderChinese(report));
  }
  if (checkOnly) {
    console.log(
      [
        `product-surface check ${passed ? "PASS" : "FAIL"}`,
        `tasks ${passedTasks}/${TASKS.length}`,
        `actionable ${actionableTasks}/${TASKS.length}`,
        `personalized ${personalizedPassed}/${personalizedTasks.length}`,
      ].join(", "),
    );
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
