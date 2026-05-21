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
        label: "AI Agent 的软件命令层",
        lead: "让 Agent 像调用 API 一样调用真实软件。",
        body: `Uni-CLI 把 ${siteIndex.total_sites} 个网站、登录态浏览器、桌面应用、本地命令、MCP 服务和系统能力收进一个可搜索运行时。Agent 先按意图找能力，再按策略执行，拿到证据回执；失败时还能定位到具体 adapter 和 pipeline step 继续修。`,
        primary: "30 秒跑起来",
        secondary: "看命令图鉴",
        badgesTitle: "能力墙",
        badges: [
          "Intent search",
          "Policy gated",
          "AgentEnvelope v2",
          "MCP + ACP",
          "Desktop AX",
          "Visual fallback",
          "Self-repair",
        ],
        commandTitle: "第一条命令",
        copy: "复制",
        copied: "已复制",
        thesisTitle: "不是工具列表，是执行底座。",
        thesis:
          "普通人打开 App 找按钮，Agent 需要更稳定的入口：先按意图搜能力，再带权限和参数执行，最后拿到结构化回执。Uni-CLI 把这条链路沉到基础设施里，让同一份能力可以反复调用、复盘和修复。",
        principles: [
          {
            name: "发现能力",
            text: "BM25 双语搜索把一句任务话收敛到站点、命令、参数、认证方式、风险和样例。",
          },
          {
            name: "执行动作",
            text: "Web API、Cookie 会话、浏览器 CDP、macOS AX、外部 CLI 和 visual fallback 走同一套 envelope。",
          },
          {
            name: "返回证据",
            text: "默认给 Agent 友好的 Markdown，也能输出 JSON、YAML、CSV 和 compact，并保留 run evidence。",
          },
          {
            name: "修复现场",
            text: "错误会带 adapter path、失败 step、retryable、suggestion 和 alternatives，方便本地 override 后验证。",
          },
        ],
        questionsTitle: "为什么需要它",
        questions: [
          {
            q: "它到底给 Agent 增加了什么？",
            a: "一个稳定入口。网页、桌面应用、本机命令和协议服务都能变成 catalog 里的命令，而不是每次临场猜 API、selector 和输出格式。",
          },
          {
            q: "为什么不是直接让 Agent 操作网页？",
            a: "直接操作适合最后一公里。Uni-CLI 先把可复用路径整理成命令，必要时再落到浏览器、桌面 AX 或 visual fallback。",
          },
          {
            q: "页面改版或本地应用不配合怎么办？",
            a: "错误 envelope 会给出 adapter 文件、失败 step 和建议。Agent 可以改本地 override，再跑 repair 验证；本地应用走平台 transport 和视觉 fallback。",
          },
          {
            q: "和 MCP 是什么关系？",
            a: "MCP 是接入方式之一。Uni-CLI 的核心是命令目录、运行时、输出合同、权限策略和修复 loop。",
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
            text: "macOS AX、后台输入、Office、设计工具、音视频工具、容器、本地 subprocess。",
          },
          {
            name: "Agent 协议",
            text: "MCP stdio / Streamable（兼容旧版 `sse` 别名）、ACP、agent matrix、skills export 和配置生成。",
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
        label: "CLI surface for real software operations",
        lead: "Search. Execute. Prove. Repair. Reuse.",
        body: `Uni-CLI gives agents a governed command layer over ${siteIndex.total_sites} websites and tools: logged-in browsers, desktop apps, local CLIs, MCP servers, and system capabilities. Agents discover by intent, execute with policy, return evidence, and trace failures to adapters and pipeline steps.`,
        primary: "Start in 30 seconds",
        secondary: "Browse the catalog",
        badgesTitle: "Capability wall",
        badges: [
          "Intent search",
          "Policy gated",
          "AgentEnvelope v2",
          "MCP + ACP",
          "Desktop AX",
          "Visual fallback",
          "Self-repair",
        ],
        commandTitle: "First command",
        copy: "Copy",
        copied: "Copied",
        thesisTitle: "Not a tool list. An execution substrate.",
        thesis:
          "People open apps and look for buttons. Agents need a steadier path: search by intent, inspect permissions and arguments, execute through a governed runtime, and receive a structured receipt. Uni-CLI turns that chain into infrastructure.",
        principles: [
          {
            name: "Discover",
            text: "Bilingual BM25 search maps a task to the site, command, arguments, auth mode, risk, and examples.",
          },
          {
            name: "Execute",
            text: "Web APIs, cookie sessions, browser CDP, macOS AX, external CLIs, and visual fallback share one envelope.",
          },
          {
            name: "Evidence",
            text: "Markdown is the agent-friendly default, with JSON, YAML, CSV, compact output, and run evidence for review.",
          },
          {
            name: "Repair",
            text: "Errors carry adapter path, failed step, retryability, suggestions, and alternatives for local override verification.",
          },
        ],
        questionsTitle: "Why it matters",
        questions: [
          {
            q: "What does this add for an agent?",
            a: "A stable entrypoint. Sites, desktop apps, local commands, and protocol servers become catalog commands instead of one-off API guesses, selector guesses, and output guesses.",
          },
          {
            q: "Why not just drive the browser directly?",
            a: "Direct operation is the last mile. Uni-CLI compiles reusable paths into commands first, then falls back to browser, desktop AX, or visual input when the semantic path is not enough.",
          },
          {
            q: "What happens when a site or app changes?",
            a: "The error envelope gives the adapter file, failed step, and suggestion. Agents can patch a local override and verify with repair; local apps route through platform transports and visual fallback.",
          },
          {
            q: "How does MCP fit?",
            a: "MCP is one integration path. The core pieces are the command catalog, runtime, output contract, permission policy, and repair loop.",
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
            text: "macOS AX, background input, Office, design tools, media tools, containers, and local subprocesses.",
          },
          {
            name: "Agent protocols",
            text: "MCP stdio / Streamable (legacy `sse` alias), ACP, agent matrix, skills export, and config generation.",
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

      <div class="uni-hero-badges" :aria-label="copy.badgesTitle">
        <span v-for="badge in copy.badges" :key="badge">{{ badge }}</span>
      </div>

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
