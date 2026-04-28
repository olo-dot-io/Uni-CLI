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
const firstCommand = computed(() =>
  isZh.value
    ? `npm install -g @zenalexa/unicli
unicli search "查 Reddit 上的 AI agent 讨论"
unicli agents recommend codex
unicli mcp serve --transport streamable --port 19826`
    : `npm install -g @zenalexa/unicli
unicli search "find AI agent discussions on reddit"
unicli agents recommend codex
unicli mcp serve --transport streamable --port 19826`,
);

const copy = computed(() =>
  isZh.value
    ? {
        label: "给 Agent 的软件启动台",
        lead: "先搜一下，网站、桌面应用、本机工具就能变成一条能跑的命令。",
        body: "Uni-CLI 把 235 个站点和工具做成一本文档化的命令图鉴。Agent 可以查目录、看参数、带认证执行、拿 Markdown 或 JSON，出错时还能定位到 adapter 和 pipeline step。写文档、抓资料、跑本机工具、接 MCP，走同一套路径。",
        primary: "5 分钟跑起来",
        secondary: "看命令图鉴",
        commandTitle: "第一条命令",
        copy: "复制",
        copied: "已复制",
        thesisTitle: "Agent 的技能图鉴。",
        thesis:
          "普通人打开 App 找按钮，Agent 需要一个更稳定的入口：先按意图搜技能，再按参数执行，最后拿到结构化回执。Uni-CLI 做的就是这层入口。",
        principles: [
          {
            name: "找技能",
            text: "BM25 双语搜索把一句任务话收敛到站点、命令、参数、认证方式和样例。",
          },
          {
            name: "跑任务",
            text: "Web API、浏览器 CDP、macOS、桌面应用、外部 CLI 和 CUA 都走同一套 envelope。",
          },
          {
            name: "交回执",
            text: "默认给 Agent 友好的 Markdown，也能输出 JSON、YAML、CSV 和 compact。",
          },
          {
            name: "修现场",
            text: "错误会带 adapter path、失败 step、retryable、suggestion 和 alternatives。",
          },
        ],
        questionsTitle: "几个直白问题",
        questions: [
          {
            q: "这东西到底帮 Agent 做什么？",
            a: "帮它找到可执行入口。网页、桌面应用、本机命令和协议服务都能变成 catalog 里的命令。",
          },
          {
            q: "为什么要先搜目录？",
            a: "因为目录里有参数、认证、风险和输出字段。Agent 先看清楚，再执行。",
          },
          {
            q: "页面改版了怎么办？",
            a: "错误 envelope 会给出 adapter 文件、失败 step 和建议。Agent 可以改本地 override，再跑 repair 验证。",
          },
          {
            q: "和 MCP 是什么关系？",
            a: "MCP 是接入方式之一。Uni-CLI 的核心还是命令目录、运行时、输出合同和修复 loop。",
          },
        ],
        workflowTitle: "一条任务怎么跑起来",
        coverageTitle: "当前能力",
        coverageText:
          "这些数字来自当前仓库生成物：adapter、命令、pipeline step、测试和 transport 都在本地构建流程里计数。",
        stats: [
          { value: siteIndex.total_sites, label: "站点和工具" },
          { value: siteIndex.total_commands, label: "命令" },
          { value: String(stats.pipeline_step_count), label: "pipeline step" },
          { value: String(stats.test_count), label: "测试" },
        ],
        surfacesTitle: "它现在能接这些面",
        surfaces: [
          {
            name: "网页和社区",
            text: "公开 API、Cookie 会话、RSS、搜索、下载、发布，以及常用中文平台。",
          },
          {
            name: "浏览器动作",
            text: "CDP 导航、点击、输入、拦截、截图、快照和动作前后证据。",
          },
          {
            name: "桌面和本机",
            text: "macOS、Office、设计工具、音视频工具、容器、本地 subprocess。",
          },
          {
            name: "Agent 协议",
            text: "MCP stdio / Streamable / SSE、ACP、agent matrix、skills export 和配置生成。",
          },
        ],
        entriesTitle: "从这里进文档",
        entries: [
          {
            title: "安装运行",
            text: "装好 CLI，跑第一条搜索，理解输出格式和退出码。",
            href: "/zh/guide/getting-started",
          },
          {
            title: "命令图鉴",
            text: "按站点、surface、认证方式和样例找能力。",
            href: "/zh/reference/sites",
          },
          {
            title: "修 adapter",
            text: "看 YAML、pipeline step、自修复流程和验证方式。",
            href: "/zh/guide/adapters",
          },
          {
            title: "接 Agent",
            text: "原生 CLI、MCP、ACP、agent config 和 skills export。",
            href: "/zh/guide/integrations",
          },
        ],
        indexText: "Agent 可读索引",
        version: `v${releaseInfo.version} · ${releaseInfo.codename}`,
      }
    : {
        label: "A software launchpad for agents",
        lead: "Search once, then turn sites, apps, and local tools into commands an agent can run.",
        body: "Uni-CLI turns 235 sites and tools into a documented command catalog. Agents can inspect arguments, run with auth, receive Markdown or JSON, and trace failures to adapters and pipeline steps. Research, docs work, local tools, and MCP integrations all use the same path.",
        primary: "Start in 5 minutes",
        secondary: "Browse the catalog",
        commandTitle: "First command",
        copy: "Copy",
        copied: "Copied",
        thesisTitle: "An executable skill catalog.",
        thesis:
          "People open apps and look for buttons. Agents need a steadier path: search by intent, inspect the command, run with clear inputs, and receive a structured receipt. Uni-CLI is that execution layer.",
        principles: [
          {
            name: "Find",
            text: "Bilingual BM25 search maps a task to the site, command, arguments, auth mode, and examples.",
          },
          {
            name: "Run",
            text: "Web APIs, browser CDP, macOS, desktop apps, external CLIs, and CUA share one envelope.",
          },
          {
            name: "Return",
            text: "Markdown is the agent-friendly default, with JSON, YAML, CSV, and compact formats for programs.",
          },
          {
            name: "Repair",
            text: "Errors carry adapter path, failed step, retryability, suggestions, and alternatives.",
          },
        ],
        questionsTitle: "Plain questions",
        questions: [
          {
            q: "What does this give an agent?",
            a: "Executable entrypoints. Sites, desktop apps, local commands, and protocol servers become commands in a catalog.",
          },
          {
            q: "Why start with search?",
            a: "The catalog shows arguments, auth, risk, and output fields before execution.",
          },
          {
            q: "What happens when a site changes?",
            a: "The error envelope gives the adapter file, failed step, and suggestion. Agents can patch a local override and verify with repair.",
          },
          {
            q: "How does MCP fit?",
            a: "MCP is one integration path. The core pieces are the command catalog, runtime, output contract, and repair loop.",
          },
        ],
        workflowTitle: "How a task moves through it",
        coverageTitle: "Current surface",
        coverageText:
          "These numbers come from the current generated repo artifacts: adapters, commands, pipeline steps, tests, and transports are counted by the build.",
        stats: [
          { value: siteIndex.total_sites, label: "sites and tools" },
          { value: siteIndex.total_commands, label: "commands" },
          { value: String(stats.pipeline_step_count), label: "pipeline steps" },
          { value: String(stats.test_count), label: "tests" },
        ],
        surfacesTitle: "What it can reach today",
        surfaces: [
          {
            name: "Web and communities",
            text: "Public APIs, cookie sessions, RSS, search, downloads, publishing, and Chinese platforms.",
          },
          {
            name: "Browser actions",
            text: "CDP navigation, clicks, typing, intercepts, screenshots, snapshots, and before/after evidence.",
          },
          {
            name: "Desktop and local",
            text: "macOS, Office, design tools, media tools, containers, and local subprocesses.",
          },
          {
            name: "Agent protocols",
            text: "MCP stdio / Streamable / SSE, ACP, agent matrix, skills export, and config generation.",
          },
        ],
        entriesTitle: "Start here",
        entries: [
          {
            title: "Install",
            text: "Install the CLI, run the first search, and learn output formats plus exit codes.",
            href: "/guide/getting-started",
          },
          {
            title: "Command catalog",
            text: "Find capabilities by site, surface, auth mode, and examples.",
            href: "/reference/sites",
          },
          {
            title: "Repair adapters",
            text: "Read YAML, pipeline steps, the repair flow, and verification commands.",
            href: "/guide/adapters",
          },
          {
            title: "Connect agents",
            text: "Native CLI, MCP, ACP, agent configs, and skills export.",
            href: "/guide/integrations",
          },
        ],
        indexText: "Agent-readable index",
        version: `v${releaseInfo.version} · ${releaseInfo.codename}`,
      },
);

async function copyFirstCommand() {
  if (!navigator.clipboard) {
    return;
  }

  try {
    await navigator.clipboard.writeText(firstCommand.value);
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

      <div class="uni-section-body">
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
      </div>
    </section>

    <section class="uni-home-section uni-qa" aria-labelledby="uni-qa-title">
      <p class="uni-section-label">{{ isZh ? "问答" : "Questions" }}</p>
      <h2 id="uni-qa-title">{{ copy.questionsTitle }}</h2>
      <div class="uni-section-body uni-qa-list">
        <article v-for="item in copy.questions" :key="item.q">
          <h3>{{ item.q }}</h3>
          <p>{{ item.a }}</p>
        </article>
      </div>
    </section>

    <section
      class="uni-home-section uni-workflow"
      aria-labelledby="uni-workflow-title"
    >
      <p class="uni-section-label">{{ isZh ? "工作流" : "Workflow" }}</p>
      <h2 id="uni-workflow-title">{{ copy.workflowTitle }}</h2>
      <div class="uni-section-body">
        <CommandLifecycleIsland />
      </div>
    </section>

    <section
      class="uni-home-section uni-coverage"
      aria-labelledby="uni-coverage-title"
    >
      <p class="uni-section-label">{{ isZh ? "目录规模" : "Coverage" }}</p>
      <h2 id="uni-coverage-title">{{ copy.coverageTitle }}</h2>
      <div class="uni-section-body uni-coverage-body">
        <p>{{ copy.coverageText }}</p>
        <dl class="uni-stat-table">
          <div v-for="stat in copy.stats" :key="stat.label">
            <dt>{{ stat.label }}</dt>
            <dd>{{ stat.value }}</dd>
          </div>
        </dl>
      </div>
    </section>

    <section
      class="uni-home-section uni-surfaces"
      aria-labelledby="uni-surfaces-title"
    >
      <p class="uni-section-label">{{ isZh ? "Surface" : "Surfaces" }}</p>
      <h2 id="uni-surfaces-title">{{ copy.surfacesTitle }}</h2>
      <div class="uni-section-body uni-surface-list">
        <article v-for="surface in copy.surfaces" :key="surface.name">
          <h3>{{ surface.name }}</h3>
          <p>{{ surface.text }}</p>
        </article>
      </div>
    </section>

    <section
      class="uni-home-section uni-entry-list"
      aria-labelledby="uni-entry-title"
    >
      <p class="uni-section-label">{{ isZh ? "入口" : "Entrypoints" }}</p>
      <h2 id="uni-entry-title">{{ copy.entriesTitle }}</h2>
      <ol class="uni-section-body">
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
