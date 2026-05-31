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
        label: "AI Agent 控制 computer 的通用平台",
        lead: "浏览器、MCP、sandbox、桌面和本地工具，都是同一只手的不同手指。",
        body: `Uni-CLI 把 ${siteIndex.total_sites} 个网站和工具、登录态浏览器、桌面应用、本地命令、文件、MCP 服务、无障碍树、截图和系统能力收进一套可搜索、可治理、可观察、可修复的操作层。Agent 先按意图选择行动 substrate，再按策略执行，拿到证据回执；失败时继续诊断、修复或换路，直到结果交付。`,
        primary: "30 秒跑起来",
        secondary: "看操作目录",
        badgesTitle: "控制面",
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
        thesisTitle:
          "不是 wrapper，不是工具列表，是 Agent 控制 computer 的手。",
        thesis:
          "普通人打开 App 找按钮，Agent 需要更稳定的手：先理解意图，再选择 API、browser、desktop、subprocess、protocol 或 visual 这类 substrate，带权限和参数行动，最后拿到结构化回执。Uni-CLI 把这条链路沉到平台里，让同一份操作可以跨 CLI、MCP、ACP、skills 和本地 runtime 反复调用、复盘、修复和交付。",
        principles: [
          {
            name: "理解意图",
            text: "BM25 双语搜索把一句任务话收敛到操作、参数、认证姿态、风险和样例。",
          },
          {
            name: "选择 substrate",
            text: "Web API、Cookie 会话、浏览器 CDP、macOS AX、外部 CLI、protocol 和 visual fallback 走同一套控制内核。",
          },
          {
            name: "返回证据",
            text: "默认给 Agent 友好的 Markdown，也能输出 JSON、YAML、CSV 和 compact，并保留 run evidence。",
          },
          {
            name: "修复或换路",
            text: "错误会带 source path、失败 step 或边界、retryable、suggestion 和 alternatives，方便本地 override 或 delivery reroute 后验证。",
          },
        ],
        questionsTitle: "为什么需要它",
        questions: [
          {
            q: "它到底给 Agent 增加了什么？",
            a: "一只通用的 computer-control 手。网页、桌面应用、本机命令、文件和协议服务都进入同一个操作合同，而不是每次临场猜 API、selector 和输出格式。",
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
            a: "MCP 是 exposure/protocol substrate 之一。Uni-CLI 的核心是 operation contract、control kernel、输出回执、权限策略和 delivery/repair loop。",
          },
        ],
        workflowTitle: "一条任务怎样控制 computer",
        coverageTitle: "当前能力",
        coverageText:
          "这些数字来自当前仓库生成物：operation、adapter、pipeline step、测试和 substrate 都在本地构建流程里计数。",
        stats: [
          { value: siteIndex.total_sites, label: "站点和工具" },
          { value: siteIndex.total_commands, label: "操作" },
          { value: String(stats.pipeline_step_count), label: "pipeline step" },
          { value: String(stats.test_count), label: "测试" },
        ],
        surfacesTitle: "它现在能控制这些 substrate",
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
            title: "操作目录",
            text: "按站点、substrate、认证方式和样例找操作。",
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
        label: "Universal computer-control platform for agents",
        lead: "Browsers, MCP, sandboxes, desktops, and local tools are fingers of one hand.",
        body: `Uni-CLI turns ${siteIndex.total_sites} websites and tools, logged-in browsers, desktop apps, local commands, files, MCP servers, accessibility trees, screenshots, and system capabilities into searchable, governed, observable, repairable operations. Agents select an action substrate by intent, execute with policy, receive evidence, then diagnose, repair, or reroute until the result is delivered.`,
        primary: "Start in 30 seconds",
        secondary: "Browse operations",
        badgesTitle: "Control surface",
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
        thesisTitle:
          "Not a wrapper. Not a tool list. The hand agents use to control computers.",
        thesis:
          "People open apps and look for buttons. Agents need a steadier hand: understand intent, choose an API, browser, desktop, subprocess, protocol, or visual substrate, act with permissions and arguments, and receive a structured receipt. Uni-CLI turns that chain into a platform across CLI, MCP, ACP, skills, and local runtimes.",
        principles: [
          {
            name: "Intent",
            text: "Bilingual BM25 search maps a task to operations, arguments, auth posture, risk, and examples.",
          },
          {
            name: "Substrate",
            text: "Web APIs, cookie sessions, browser CDP, macOS AX, external CLIs, protocols, and visual fallback share one control kernel.",
          },
          {
            name: "Evidence",
            text: "Markdown is the agent-friendly default, with JSON, YAML, CSV, compact output, and run evidence for review.",
          },
          {
            name: "Repair or reroute",
            text: "Errors carry source path, failed step or boundary, retryability, suggestions, and alternatives for local override or delivery reroute verification.",
          },
        ],
        questionsTitle: "Why it matters",
        questions: [
          {
            q: "What does this add for an agent?",
            a: "A universal computer-control hand. Sites, desktop apps, local commands, files, and protocol servers become governed operation contracts instead of one-off API guesses, selector guesses, and output guesses.",
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
            a: "MCP is one exposure/protocol substrate. The core pieces are operation contracts, the control kernel, output receipts, permission policy, and the delivery/repair loop.",
          },
        ],
        workflowTitle: "How a task controls a computer",
        coverageTitle: "Current surface",
        coverageText:
          "These numbers come from the current generated repo artifacts: operations, adapters, pipeline steps, tests, and substrates are counted by the build.",
        stats: [
          { value: siteIndex.total_sites, label: "sites and tools" },
          { value: siteIndex.total_commands, label: "operations" },
          { value: String(stats.pipeline_step_count), label: "pipeline steps" },
          { value: String(stats.test_count), label: "tests" },
        ],
        surfacesTitle: "What it can control today",
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
            title: "Operation catalog",
            text: "Find operations by site, substrate, auth mode, and examples.",
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
