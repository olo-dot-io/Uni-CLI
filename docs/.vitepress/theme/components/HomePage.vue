<!--
@owner docs/.vitepress/theme/components/HomePage.vue
@does Render the bilingual public landing page and task-directed substrate map.
@needs docs/release-info.json, docs/site-index.json, stats.json, VitePress locale/base data, browser Clipboard API
@feeds English and Chinese documentation homepages
@breaks Stale product claims or generated counts misrepresent the public Agent-Computer Interface surface.
@invariants English and Chinese copy describe the same operation contract and routing order.
@side-effects Copies the first-command block on explicit user action and updates local reactive state.
@perf O(1) over static copy and generated scalar counts per render.
@concurrency Browser-main-thread Vue reactivity; clipboard completion may resolve asynchronously.
@test npm run docs:build verifies the compiled public surface
@stability stable
@since 2026-04-28
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useData, withBase } from "vitepress";
import homeOperation from "../../../home-operation.json";
import releaseInfo from "../../../release-info.json";
import siteIndex from "../../../site-index.json";
import stats from "../../../../stats.json";
import OperationReceipt from "./OperationReceipt.vue";

const { localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");
const copyState = ref<"idle" | "copied" | "failed">("idle");
const firstCommand = computed(() =>
  isZh.value
    ? `npm install -g @zenalexa/unicli
unicli search "${homeOperation.intent.zh}"
${homeOperation.shell}`
    : `npm install -g @zenalexa/unicli
unicli search "${homeOperation.intent.en.toLowerCase()}"
${homeOperation.shell}`,
);

const copy = computed(() =>
  isZh.value
    ? {
        eyebrow: "OPEN AGENT-COMPUTER INTERFACE",
        titleA: "一个接口。",
        titleB: "跨越多种软件边界。",
        lead: "发现 operation，选择一条明确 substrate，拿回可检查的结果。",
        body: `Uni-CLI 把 ${siteIndex.total_sites} 个网站和工具、登录态浏览器、桌面应用、本地命令、文件与 Agent 协议组织成一个 operation-first runtime。`,
        primary: "开始使用",
        secondary: "浏览 operation",
        commandTitle: "FIRST ROUTE",
        copy: "复制",
        copied: "已复制",
        copyFailed: "请手动选择",
        routeLabel: "ROUTE BY TASK",
        routeTitle: "任务决定能力选择。",
        routeIntro:
          "Operation 目录负责发现和合同；执行再选择结构最强、范围最小的 operator。每次只运行一个 provider，失败保留原始原因与修复入口。",
        routes: [
          {
            index: "01",
            task: "公开数据或稳定服务接口",
            substrate: "Structured API",
            detail: "直接读取 typed response，保留字段、认证姿态和来源。",
          },
          {
            index: "02",
            task: "文件、系统状态、本地工具",
            substrate: "Local runtime",
            detail: "直接走操作系统或进程边界，避免引入浏览器状态。",
          },
          {
            index: "03",
            task: "需要登录态或私有网络合同的网页",
            substrate: "Browser protocol",
            detail: "复用明确的 browser profile、Cookie 或 network contract。",
          },
          {
            index: "04",
            task: "只有页面界面的网页流程",
            substrate: "Semantic browser",
            detail: "使用 DOM、CDP 与页面语义；目标和会话保持显式。",
          },
          {
            index: "05",
            task: "原生桌面应用",
            substrate: "Accessibility",
            detail: "优先 AX、UIA、AT-SPI 等结构化控件树。",
          },
          {
            index: "06",
            task: "像素级或无结构界面",
            substrate: "Visual computer use",
            detail: "仅在缺少更强接口时使用坐标与视觉 observation。",
          },
        ],
        workflowLabel: "OPERATION RECEIPT",
        workflowTitle: "从意图到结果，路径始终可见。",
        surfaceLabel: "CURRENT SURFACE",
        surfaceTitle: "一套合同，跨越真实软件。",
        surfaces: [
          {
            name: "Catalog",
            value: String(siteIndex.total_sites),
            text: "网站、桌面应用、本地工具和协议的可搜索 operation 合同。",
          },
          {
            name: "Browser",
            value: "CDP",
            text: "导航、语义动作、网络、快照、截图与执行后证据。",
          },
          {
            name: "Desktop",
            value: "AX",
            text: "桌面控件、本机系统、设计工具、Office 与媒体软件。",
          },
          {
            name: "Protocols",
            value: "MCP",
            text: "原生 CLI、MCP stdio / Streamable、ACP、skills 与配置生成。",
          },
        ],
        stats: [
          { value: siteIndex.total_commands, label: "registered operations" },
          { value: stats.adapter_count_total, label: "adapters" },
          { value: stats.pipeline_step_count, label: "pipeline actions" },
          { value: stats.test_count, label: "tests" },
        ],
        entriesLabel: "START HERE",
        entriesTitle: "选一个入口，开始执行。",
        entries: [
          {
            number: "01",
            title: "安装运行",
            text: "从第一条 intent search 到结构化结果。",
            href: "/zh/guide/getting-started",
          },
          {
            number: "02",
            title: "Operation 目录",
            text: "按站点、认证和 substrate 查找能力。",
            href: "/zh/reference/sites",
          },
          {
            number: "03",
            title: "接入 Agent",
            text: "配置 CLI、MCP、ACP 和 agent skills。",
            href: "/zh/guide/integrations",
          },
          {
            number: "04",
            title: "修复 Adapter",
            text: "读取失败边界，修改 owned source，再验证。",
            href: "/zh/guide/self-repair",
          },
        ],
        indexText: "AGENT INDEX",
        version: `v${releaseInfo.version} · ${releaseInfo.codename}`,
      }
    : {
        eyebrow: "OPEN AGENT-COMPUTER INTERFACE",
        titleA: "One interface.",
        titleB: "Across real software.",
        lead: "Discover the operation. Select one declared substrate. Keep the outcome inspectable.",
        body: `Uni-CLI organizes ${siteIndex.total_sites} sites and tools, logged-in browsers, desktop apps, local commands, files, and agent protocols into one operation-first runtime.`,
        primary: "Get started",
        secondary: "Browse operations",
        commandTitle: "FIRST ROUTE",
        copy: "Copy",
        copied: "Copied",
        copyFailed: "Select manually",
        routeLabel: "ROUTE BY TASK",
        routeTitle: "The task chooses the capability.",
        routeIntro:
          "The operation catalog handles discovery and contracts. Execution then selects the strongest operator with the smallest effective scope. One provider runs; failures preserve their cause and repair route.",
        routes: [
          {
            index: "01",
            task: "Public data or stable service interface",
            substrate: "Structured API",
            detail:
              "Read the typed response directly while preserving fields, auth posture, and source identity.",
          },
          {
            index: "02",
            task: "Files, system state, local tools",
            substrate: "Local runtime",
            detail:
              "Cross the operating-system or process boundary directly without browser state.",
          },
          {
            index: "03",
            task: "Authenticated or private web contract",
            substrate: "Browser protocol",
            detail:
              "Reuse an explicit browser profile, cookie session, or network contract.",
          },
          {
            index: "04",
            task: "Page-only web flow",
            substrate: "Semantic browser",
            detail:
              "Use DOM and CDP semantics with an explicit target and session contract.",
          },
          {
            index: "05",
            task: "Native desktop application",
            substrate: "Accessibility",
            detail:
              "Prefer structured AX, UIA, or AT-SPI control trees when available.",
          },
          {
            index: "06",
            task: "Pixel-only or unstructured interface",
            substrate: "Visual computer use",
            detail:
              "Use coordinates and visual observation only when no stronger interface exists.",
          },
        ],
        workflowLabel: "OPERATION RECEIPT",
        workflowTitle: "Intent becomes an outcome without hiding the route.",
        surfaceLabel: "CURRENT SURFACE",
        surfaceTitle: "One contract across real software.",
        surfaces: [
          {
            name: "Catalog",
            value: String(siteIndex.total_sites),
            text: "Searchable operation contracts for sites, desktop apps, local tools, and protocols.",
          },
          {
            name: "Browser",
            value: "CDP",
            text: "Navigation, semantic action, network, snapshots, screenshots, and post-action evidence.",
          },
          {
            name: "Desktop",
            value: "AX",
            text: "Native controls, system services, design tools, Office, and media software.",
          },
          {
            name: "Protocols",
            value: "MCP",
            text: "Native CLI, MCP stdio and Streamable HTTP, ACP, skills, and generated configs.",
          },
        ],
        stats: [
          { value: siteIndex.total_commands, label: "registered operations" },
          { value: stats.adapter_count_total, label: "adapters" },
          { value: stats.pipeline_step_count, label: "pipeline actions" },
          { value: stats.test_count, label: "tests" },
        ],
        entriesLabel: "START HERE",
        entriesTitle: "Choose an entrypoint. Start operating.",
        entries: [
          {
            number: "01",
            title: "Install",
            text: "Go from the first intent search to a structured result.",
            href: "/guide/getting-started",
          },
          {
            number: "02",
            title: "Operation catalog",
            text: "Find capabilities by site, auth posture, and substrate.",
            href: "/reference/sites",
          },
          {
            number: "03",
            title: "Connect agents",
            text: "Configure the CLI, MCP, ACP, and agent skills.",
            href: "/guide/integrations",
          },
          {
            number: "04",
            title: "Repair adapters",
            text: "Read the failed boundary, edit owned source, then verify.",
            href: "/guide/self-repair",
          },
        ],
        indexText: "AGENT INDEX",
        version: `v${releaseInfo.version} · ${releaseInfo.codename}`,
      },
);

async function copyFirstCommand() {
  if (!navigator.clipboard) {
    copyState.value = "failed";
    return;
  }

  try {
    await navigator.clipboard.writeText(firstCommand.value);
  } catch {
    copyState.value = "failed";
    return;
  }

  copyState.value = "copied";
  window.setTimeout(() => {
    copyState.value = "idle";
  }, 1600);
}
</script>

<template>
  <main class="uni-docs-home">
    <section class="uni-landing-hero" aria-labelledby="uni-home-title">
      <img
        class="uni-hero-art"
        :src="withBase('/operation-field.webp')"
        alt=""
        width="1672"
        height="941"
        fetchpriority="high"
      />
      <div class="uni-hero-shade" aria-hidden="true" />

      <div class="uni-hero-copy">
        <div class="uni-hero-mark">
          <span aria-hidden="true" />
          {{ copy.eyebrow }}
          <b>{{ copy.version }}</b>
        </div>
        <h1 id="uni-home-title">
          <span>{{ copy.titleA }}</span>
          <span>{{ copy.titleB }}</span>
        </h1>
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
            {{ copy.primary }} <span aria-hidden="true">↗</span>
          </a>
          <a
            class="uni-link-secondary"
            :href="withBase(isZh ? '/zh/reference/sites' : '/reference/sites')"
          >
            {{ copy.secondary }} <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>

      <div class="uni-command-strip" :aria-label="copy.commandTitle">
        <div class="uni-command-meta">
          <span>{{ copy.commandTitle }}</span>
          <span>intent → operation → receipt</span>
          <button
            type="button"
            class="uni-copy-button"
            @click="copyFirstCommand"
          >
            {{
              copyState === "copied"
                ? copy.copied
                : copyState === "failed"
                  ? copy.copyFailed
                  : copy.copy
            }}
          </button>
          <span class="uni-sr-only" role="status" aria-live="polite">
            {{
              copyState === "idle"
                ? ""
                : copyState === "copied"
                  ? copy.copied
                  : copy.copyFailed
            }}
          </span>
        </div>
        <pre><code>{{ firstCommand }}</code></pre>
      </div>

      <dl class="uni-hero-stats">
        <div v-for="stat in copy.stats" :key="stat.label">
          <dt>{{ stat.label }}</dt>
          <dd>{{ stat.value }}</dd>
        </div>
      </dl>
    </section>

    <section
      class="uni-home-section uni-routing"
      aria-labelledby="uni-routing-title"
    >
      <header class="uni-section-head">
        <p class="uni-section-label">{{ copy.routeLabel }}</p>
        <h2 id="uni-routing-title">{{ copy.routeTitle }}</h2>
        <p>{{ copy.routeIntro }}</p>
      </header>

      <ol class="uni-route-list">
        <li v-for="route in copy.routes" :key="route.index">
          <span class="uni-route-index">{{ route.index }}</span>
          <strong>{{ route.task }}</strong>
          <code>{{ route.substrate }}</code>
          <p>{{ route.detail }}</p>
        </li>
      </ol>
    </section>

    <section
      class="uni-home-section uni-workflow"
      aria-labelledby="uni-workflow-title"
    >
      <header class="uni-section-head">
        <p class="uni-section-label">{{ copy.workflowLabel }}</p>
        <h2 id="uni-workflow-title">{{ copy.workflowTitle }}</h2>
      </header>
      <OperationReceipt />
    </section>

    <section
      class="uni-home-section uni-surfaces"
      aria-labelledby="uni-surfaces-title"
    >
      <header class="uni-section-head">
        <p class="uni-section-label">{{ copy.surfaceLabel }}</p>
        <h2 id="uni-surfaces-title">{{ copy.surfaceTitle }}</h2>
      </header>

      <div class="uni-surface-list">
        <article v-for="surface in copy.surfaces" :key="surface.name">
          <div>
            <span>{{ surface.name }}</span>
            <strong>{{ surface.value }}</strong>
          </div>
          <p>{{ surface.text }}</p>
        </article>
      </div>
    </section>

    <section
      class="uni-home-section uni-entry-list"
      aria-labelledby="uni-entry-title"
    >
      <header class="uni-section-head">
        <p class="uni-section-label">{{ copy.entriesLabel }}</p>
        <h2 id="uni-entry-title">{{ copy.entriesTitle }}</h2>
      </header>

      <ol>
        <li v-for="entry in copy.entries" :key="entry.href">
          <span>{{ entry.number }}</span>
          <a :href="withBase(entry.href)">{{ entry.title }}</a>
          <p>{{ entry.text }}</p>
          <b aria-hidden="true">↗</b>
        </li>
      </ol>
    </section>

    <section class="uni-index-line">
      <span>{{ copy.indexText }}</span>
      <a :href="withBase('/llms.txt')">/llms.txt</a>
      <a :href="withBase('/llms-full.txt')">/llms-full.txt</a>
      <a href="https://github.com/olo-dot-io/Uni-CLI">GitHub ↗</a>
    </section>
  </main>
</template>
