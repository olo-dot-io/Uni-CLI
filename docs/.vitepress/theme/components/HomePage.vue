<!--
@owner docs/.vitepress/theme/components/HomePage.vue
@does Render the bilingual product story, first command, capability loop, and documentation entry points.
@needs docs/release-info.json, docs/site-index.json, stats.json, VitePress locale/base data, browser Clipboard API
@feeds English and Chinese documentation homepages
@breaks Stale product claims or generated counts misrepresent the public Agent-Computer Interface surface.
@invariants English and Chinese copy describe the same category, runtime loop, and honesty boundary.
@side-effects Copies the first-command block on explicit user action and updates local reactive state.
@perf O(1) over static copy and generated scalar counts per render.
@concurrency Browser-main-thread Vue reactivity; clipboard completion may resolve asynchronously.
@test none; npm run docs:build verifies the compiled public surface
@stability stable
@since 2026-04-28
-->
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
        label: "面向真实软件的开源 Agent-Computer Interface 运行时",
        lead: "找到操作。跨过边界。让结果可检查。",
        body: `Uni-CLI 在 Agent 与 ${siteIndex.total_sites} 个网站和工具、登录态浏览器、桌面应用、本地命令、文件、MCP 服务及系统能力之间提供一个可搜索边界。它按意图排序可执行 operation，通过选中 operation 已声明的 substrate 按策略运行，返回稳定的成功/错误 envelope，并让失败可诊断、可修复。`,
        primary: "30 秒跑起来",
        secondary: "看操作目录",
        badgesTitle: "运行时合同",
        badges: [
          "Intent discovery",
          "Declared substrates",
          "Policy-aware",
          "Structured envelopes",
          "MCP + ACP",
          "Browser + Desktop",
          "Repairable paths",
        ],
        commandTitle: "第一条命令",
        copy: "复制",
        copied: "已复制",
        thesisTitle: "一个 Agent 接口，下面接住真实软件的每一种有效边界。",
        thesis:
          "模型只负责推理还不够。Agent 还需要一套为有限上下文设计的 interface：知道什么能行动、每条 operation 会走哪种 substrate、动作会影响什么、调用返回了什么，以及失败后怎样继续。Uni-CLI 不接管模型和编排；它把 API、文件、CLI、browser、desktop、protocol 和 visual 组织成一个可发现、可治理、可观察、可修复的运行时。",
        principles: [
          {
            name: "发现",
            text: "BM25 双语搜索只取当前任务相关的操作、参数、认证姿态、风险和样例。",
          },
          {
            name: "选择与治理",
            text: "Agent 选择已声明 strategy/substrate 的 operation；执行前可检查 capability scope、effect、risk 和 approval。",
          },
          {
            name: "行动与观察",
            text: "Adapter kernel 调用选中的 operation；AgentEnvelope 区分成功与错误，支持的 operation 再附加 artifact、recording 或 post-state evidence。",
          },
          {
            name: "修复",
            text: "错误指出 source path、失败边界、retryable、suggestion 和 alternatives，再验证本地修复或换路。",
          },
        ],
        questionsTitle: "为什么需要它",
        questions: [
          {
            q: "Uni-CLI 到底是什么类目？",
            a: "Agent-Computer Interface 运行时：Agent 与真实软件之间的可执行边界。CLI 是原生完整进程入口，MCP 投影 adapter operation；browser、desktop 和 visual 是行动 substrate。",
          },
          {
            q: "为什么不是直接让 Agent 操作网页？",
            a: "浏览器只是一个边界。Catalog 同时容纳 API、文件、CLI、页面语义、CDP、桌面 AX 和 visual operation；当前由 Agent 选择 operation，而不是由 runtime 自动仲裁所有路径。",
          },
          {
            q: "“结果可检查”具体是什么意思？",
            a: "所有渲染调用都用稳定 envelope 区分成功与错误；读取、文件写入、browser 变更和 desktop action 只有在对应 operation 明确支持时才附加来源、post-state、artifact 或 recording。Dispatch 不能自动证明目标完成。",
          },
          {
            q: "和 MCP 是什么关系？",
            a: "MCP 是 discovery/exposure substrate 之一。Compact、deferred 与 expanded profile 投影 adapter operation；固定 core command 当前以 native CLI 为规范入口，逐命令 parity 在路线图中。",
          },
        ],
        workflowTitle: "一条意图怎样变成可检查的结果",
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
        label: "The open Agent-Computer Interface runtime for real software",
        lead: "Find the operation. Cross the boundary. Keep the outcome inspectable.",
        body: `Uni-CLI provides one searchable boundary between agents and ${siteIndex.total_sites} websites and tools, logged-in browsers, desktop apps, local commands, files, MCP servers, and system capabilities. It ranks executable operations by intent, runs the selected operation through its declared substrate under policy, returns a stable success/error envelope, and keeps failure diagnosable and repairable.`,
        primary: "Start in 30 seconds",
        secondary: "Browse operations",
        badgesTitle: "Runtime contract",
        badges: [
          "Intent discovery",
          "Declared substrates",
          "Policy-aware",
          "Structured envelopes",
          "MCP + ACP",
          "Browser + Desktop",
          "Repairable paths",
        ],
        commandTitle: "First command",
        copy: "Copy",
        copied: "Copied",
        thesisTitle:
          "One agent interface. Every useful software boundary underneath.",
        thesis:
          "A model that can reason still needs an interface designed for bounded context: what can act, which substrate an operation declares, what the action can affect, what the call returned, and how to continue after failure. Uni-CLI does not replace the model or orchestrator. It organizes APIs, files, CLIs, browsers, desktops, protocols, and visual control into one discoverable, governed, observable, repairable runtime.",
        principles: [
          {
            name: "Discover",
            text: "Bilingual BM25 search retrieves only the operations, arguments, auth posture, risk, and examples relevant to the task.",
          },
          {
            name: "Select and govern",
            text: "The agent selects an operation with a declared strategy and substrate; capability scope, effect, risk, and approval remain inspectable before execution.",
          },
          {
            name: "Act and observe",
            text: "The adapter kernel invokes the selected operation; AgentEnvelope distinguishes success from error, and supporting operations add artifacts, recordings, or post-state evidence.",
          },
          {
            name: "Repair",
            text: "Errors name the source path, failed boundary, retryability, suggestion, and alternatives, then verify a local repair or reroute.",
          },
        ],
        questionsTitle: "Why it matters",
        questions: [
          {
            q: "What category is Uni-CLI?",
            a: "An Agent-Computer Interface runtime: the executable boundary between an agent and real software. CLI is the native full process entry point; MCP projects adapter operations, while browser, desktop, and visual control are action substrates.",
          },
          {
            q: "Why not just drive the browser directly?",
            a: "The browser is one boundary. The catalog can hold API, file, CLI, page-semantic, CDP, desktop-accessibility, and visual operations. Today the agent selects the operation; the runtime does not arbitrate every alternative automatically.",
          },
          {
            q: "What does an inspectable outcome mean?",
            a: "Every rendered call distinguishes success from error in a stable envelope. Reads, file writes, browser mutations, and desktop actions add provenance, post-state, artifacts, or recordings only when that operation supports them. Dispatch cannot prove objective completion.",
          },
          {
            q: "How does MCP fit?",
            a: "MCP is one discovery and exposure substrate. Compact, deferred, and expanded profiles project adapter operations. Fixed core commands are currently canonical on native CLI; command-level parity is roadmap work.",
          },
        ],
        workflowTitle: "How intent becomes an inspectable result",
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
