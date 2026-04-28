<script setup lang="ts">
import { computed, ref } from "vue";
import { useData, withBase } from "vitepress";
import releaseInfo from "../../../release-info.json";
import siteIndex from "../../../site-index.json";
import stats from "../../../../stats.json";
import CommandLifecycleIsland from "./CommandLifecycleIsland.vue";

const { localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");
const copiedCommand = ref(false);
const firstCommand = `npm install -g @zenalexa/unicli
unicli search "twitter trending"
unicli twitter trending --limit 10 -f json`;

const copy = computed(() =>
  isZh.value
    ? {
        label: "面向 Agent 的软件执行层",
        lead: "让 Agent 可靠操作网页、应用和本机工具。",
        body: "Agent 正从聊天助手走向任务执行系统：它需要调用 CLI、API、浏览器和桌面应用，也需要审计记录、权限边界和失败后的恢复路径。Uni-CLI 把这些软件入口整理成同一套可搜索、可执行、可追踪、可修复的命令接口。",
        primary: "安装运行",
        secondary: "浏览命令",
        commandTitle: "第一条命令",
        copy: "复制",
        copied: "已复制",
        thesisTitle: "不是再造一个协议层，而是补齐 Agent 执行的工程面。",
        thesis:
          "MCP 解决互操作，browser / computer-use 补 API 空白；真正进入生产环境时，还需要命令目录、权限策略、可审计输出、退出码和修复循环。Uni-CLI 把这些放在原生 CLI 入口下，并继续提供 MCP / ACP 兼容。",
        principles: [
          {
            name: "统一入口",
            text: "同一个目录覆盖公开 API、Cookie 会话、浏览器、桌面应用、外部 CLI 和本机能力。",
          },
          {
            name: "可审计执行",
            text: "参数、认证、权限 profile、输出结构和退出码在运行前后都能检查，不靠 prompt 约定。",
          },
          {
            name: "可恢复失败",
            text: "外部页面或 API 变了，错误要指向 adapter 文件、pipeline step 和复现命令。",
          },
        ],
        workflowTitle: "一条命令的生命周期",
        coverageTitle: "当前覆盖范围",
        coverageText:
          "同一套调用路径覆盖公开 API、Cookie 会话、浏览器、桌面应用、外部 CLI 和本机能力。",
        stats: [
          { value: siteIndex.total_sites, label: "站点和工具" },
          { value: siteIndex.total_commands, label: "命令" },
          { value: String(stats.pipeline_step_count), label: "pipeline step" },
          { value: "v2", label: "AgentEnvelope" },
        ],
        entriesTitle: "从任务进入",
        entries: [
          {
            title: "安装运行",
            text: "安装、搜索、运行、认证和常见退出码。",
            href: "/zh/guide/getting-started",
          },
          {
            title: "命令目录",
            text: "按站点、接口类型、认证方式和命令样例检索。",
            href: "/zh/reference/sites",
          },
          {
            title: "写或修 adapter",
            text: "YAML 格式、pipeline step、自修复流程和验证方式。",
            href: "/zh/guide/adapters",
          },
          {
            title: "接入 Agent",
            text: "原生 CLI、MCP、ACP 和可消费输出的取舍。",
            href: "/zh/guide/integrations",
          },
        ],
        indexText: "给 Agent 读取的索引",
        version: `当前 latest：v${releaseInfo.version} · ${releaseInfo.codename}`,
      }
    : {
        label: "Software execution for agents",
        lead: "Let agents operate websites, apps, and local tools through a real execution path.",
        body: "Agents are moving from chat assistance to task-running systems. They need to call CLIs, APIs, browsers, and desktop apps, while keeping audit trails, permission boundaries, and recovery paths. Uni-CLI turns those software surfaces into one searchable, executable, traceable, and repairable command interface.",
        primary: "Install",
        secondary: "Command catalog",
        commandTitle: "First command",
        copy: "Copy",
        copied: "Copied",
        thesisTitle:
          "The gap is not another protocol. It is the engineering surface around agent execution.",
        thesis:
          "MCP improves interoperability. Browser and computer-use automation close API gaps. Production agent workflows still need a command catalog, policy, inspectable output, exit codes, and repair loops. Uni-CLI puts that layer behind a native CLI while keeping MCP and ACP compatibility.",
        principles: [
          {
            name: "Unified entry",
            text: "One catalog covers public APIs, cookie sessions, browsers, desktop apps, external CLIs, and local capabilities.",
          },
          {
            name: "Auditable execution",
            text: "Arguments, auth, policy profiles, output shape, and exit codes stay inspectable before and after a run.",
          },
          {
            name: "Recoverable failure",
            text: "When a surface changes, the error names the adapter file, pipeline step, and verification command.",
          },
        ],
        workflowTitle: "The lifecycle of a command",
        coverageTitle: "Current public surface",
        coverageText:
          "One call path spans public APIs, cookie sessions, browsers, desktop apps, external CLIs, and local system capabilities.",
        stats: [
          { value: siteIndex.total_sites, label: "sites and tools" },
          { value: siteIndex.total_commands, label: "commands" },
          { value: String(stats.pipeline_step_count), label: "pipeline steps" },
          { value: "v2", label: "AgentEnvelope" },
        ],
        entriesTitle: "Start from the task",
        entries: [
          {
            title: "Install",
            text: "Install, search, execute, authenticate, and read exit codes.",
            href: "/guide/getting-started",
          },
          {
            title: "Command catalog",
            text: "Find commands by site, surface type, auth strategy, and examples.",
            href: "/reference/sites",
          },
          {
            title: "Write or repair adapters",
            text: "YAML format, pipeline steps, self-repair, and verification.",
            href: "/guide/adapters",
          },
          {
            title: "Integrate agents",
            text: "Native CLI, MCP, ACP, and output modes for agent runtimes.",
            href: "/guide/integrations",
          },
        ],
        indexText: "Agent-readable index",
        version: `Latest: v${releaseInfo.version} · ${releaseInfo.codename}`,
      },
);

async function copyFirstCommand() {
  if (!navigator.clipboard) {
    return;
  }

  try {
    await navigator.clipboard.writeText(firstCommand);
  } catch {
    return;
  }
  copiedCommand.value = true;
  window.setTimeout(() => {
    copiedCommand.value = false;
  }, 1600);
}
</script>

<template>
  <main class="uni-docs-home">
    <section class="uni-landing-hero" aria-labelledby="uni-home-title">
      <div class="uni-hero-label">{{ copy.label }}</div>
      <h1 id="uni-home-title">Uni-CLI</h1>
      <p class="uni-hero-lead">{{ copy.lead }}</p>
      <p class="uni-hero-body">{{ copy.body }}</p>

      <div class="uni-hero-actions">
        <a
          class="uni-link-primary"
          :href="
            withBase(
              isZh ? '/zh/guide/getting-started' : '/guide/getting-started',
            )
          "
        >
          {{ copy.primary }}
        </a>
        <a
          class="uni-link-secondary"
          :href="withBase(isZh ? '/zh/reference/sites' : '/reference/sites')"
        >
          {{ copy.secondary }}
        </a>
      </div>

      <div class="uni-command-strip" :aria-label="copy.commandTitle">
        <div>
          <span>{{ copy.commandTitle }}</span>
          <span>{{ copy.version }}</span>
          <button
            type="button"
            class="uni-copy-button"
            @click="copyFirstCommand"
          >
            {{ copiedCommand ? copy.copied : copy.copy }}
          </button>
        </div>
        <pre><code>{{ firstCommand }}</code></pre>
      </div>
    </section>

    <section
      class="uni-home-section uni-thesis"
      aria-labelledby="uni-thesis-title"
    >
      <p class="uni-section-label">{{ isZh ? "定位" : "Positioning" }}</p>
      <h2 id="uni-thesis-title">{{ copy.thesisTitle }}</h2>
      <p>{{ copy.thesis }}</p>

      <div class="uni-principle-list">
        <div
          v-for="principle in copy.principles"
          :key="principle.name"
          class="uni-principle"
        >
          <strong>{{ principle.name }}</strong>
          <span>{{ principle.text }}</span>
        </div>
      </div>
    </section>

    <section
      class="uni-home-section uni-workflow"
      aria-labelledby="uni-workflow-title"
    >
      <p class="uni-section-label">{{ isZh ? "工作流" : "Workflow" }}</p>
      <h2 id="uni-workflow-title">{{ copy.workflowTitle }}</h2>
      <CommandLifecycleIsland />
    </section>

    <section
      class="uni-home-section uni-coverage"
      aria-labelledby="uni-coverage-title"
    >
      <div>
        <p class="uni-section-label">{{ isZh ? "目录规模" : "Coverage" }}</p>
        <h2 id="uni-coverage-title">{{ copy.coverageTitle }}</h2>
        <p>{{ copy.coverageText }}</p>
      </div>
      <dl class="uni-stat-table">
        <div v-for="stat in copy.stats" :key="stat.label">
          <dt>{{ stat.label }}</dt>
          <dd>{{ stat.value }}</dd>
        </div>
      </dl>
    </section>

    <section
      class="uni-home-section uni-entry-list"
      aria-labelledby="uni-entry-title"
    >
      <p class="uni-section-label">{{ isZh ? "入口" : "Entrypoints" }}</p>
      <h2 id="uni-entry-title">{{ copy.entriesTitle }}</h2>
      <ol>
        <li v-for="entry in copy.entries" :key="entry.href">
          <a :href="withBase(entry.href)">{{ entry.title }}</a>
          <span>{{ entry.text }}</span>
        </li>
      </ol>
    </section>

    <section class="uni-home-section uni-index-line">
      <span>{{ copy.indexText }}</span>
      <a :href="withBase('/llms.txt')">/llms.txt</a>
      <a :href="withBase('/llms-full.txt')">/llms-full.txt</a>
    </section>
  </main>
</template>
