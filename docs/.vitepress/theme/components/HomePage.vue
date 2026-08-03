<!--
@owner docs/.vitepress/theme/components/HomePage.vue
@does Render the bilingual public landing page as a compact, product-led interface.
@needs docs/release-info.json, docs/site-index.json, stats.json, VitePress locale/base data, browser Clipboard API
@feeds English and Chinese documentation homepages
@breaks Stale product claims or generated counts misrepresent the public Agent-Computer Interface surface.
@invariants English and Chinese copy share one information architecture and all displayed counts come from generated sources.
@side-effects Copies the install command on explicit user action and updates local reactive state.
@perf O(1) over static copy and generated scalar counts per render.
@concurrency Browser-main-thread Vue reactivity; clipboard completion may resolve asynchronously.
@test npm run docs:build verifies the compiled public surface
@stability stable
@since 2026-08-02
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useData, withBase } from "vitepress";
import releaseInfo from "../../../release-info.json";
import siteIndex from "../../../site-index.json";
import stats from "../../../../stats.json";
import OperationReceipt from "./OperationReceipt.vue";

const { localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");
const copyState = ref<"idle" | "copied" | "failed">("idle");
const heroMode = ref<"install" | "agent">("install");
const installCommand = "npm install -g @zenalexa/unicli";
const agentInstruction = computed(() =>
  isZh.value
    ? '安装 @zenalexa/unicli；使用浏览器工具前，先运行 unicli search "<意图>"。'
    : 'Install @zenalexa/unicli. Before browser tools, run unicli search "<intent>".',
);
const heroCommand = computed(() =>
  heroMode.value === "install" ? installCommand : agentInstruction.value,
);

const brands = [
  ["googlechrome", "Chrome"],
  ["github", "GitHub"],
  ["discord", "Discord"],
  ["reddit", "Reddit"],
  ["notion", "Notion"],
  ["linear", "Linear"],
  ["figma", "Figma"],
  ["docker", "Docker"],
];

const surfaceIcons = [
  "M4 5h16v11H4zM8 20h8M12 16v4",
  "M5 4h14v16H5zM5 9h14M8 6h.01M11 6h.01",
  "M4 7h16v10H4zM8 17v3h8v-3",
  "M7 4h10v5h3v11H4V9h3zM9 8h6M8 13h8M8 16h5",
  "M12 3l2.2 4.4L19 8l-3.5 3.4.8 4.8-4.3-2.3-4.3 2.3.8-4.8L5 8l4.8-.6z",
];

const copy = computed(() =>
  isZh.value
    ? {
        nav: ["路径", "界面", "开始"],
        eyebrow: "Agent-Computer Interface",
        title: "把所有界面交给 Agent。",
        lead: "安装一次。搜索、执行、检查、修复。",
        installTab: "npm",
        agentTab: "Agent 指令",
        copyAction: "复制",
        secondary: "打开文档",
        copied: "已复制",
        copyFailed: "手动选择",
        brandLabel: "真实软件",
        brandTitle: "Agent 从这里开始工作。",
        routeLabel: "01 · FIND",
        routeTitle: "找到正确的 operation。",
        routeLead: "输入意图，选择路径，拿到结构化结果。",
        repairLabel: "02 · REPAIR",
        repairTitle: "运行。检查。修复。",
        repairLead: "Adapter 可读、可改、可继续执行。",
        repairSteps: ["Run", "Inspect", "Repair"],
        surfaceLabel: "03 · SURFACES",
        surfaceTitle: "一套接口，抵达真实软件。",
        surfaces: [
          ["Web", "API · DOM · Cookie"],
          ["Browser", "CDP · Network · Snapshot"],
          ["Desktop", "AX · UIA · AT-SPI"],
          ["System", "File · Process · CLI"],
          ["Agents", "MCP · ACP · Skills"],
        ],
        stats: [
          [String(siteIndex.total_sites), "站点与工具"],
          [String(siteIndex.total_commands), "operations"],
          [String(stats.pipeline_step_count), "pipeline actions"],
          [String(stats.test_count), "tests"],
        ],
        startLabel: "04 · START",
        startTitle: "选一个入口。",
        footerLabel: "开放式 Agent-Computer Interface",
        license: "Apache-2.0 许可证",
        entries: [
          ["安装运行", "/zh/guide/getting-started"],
          ["浏览 operation", "/zh/reference/sites"],
          ["接入 Agent", "/zh/guide/integrations"],
          ["修复 adapter", "/zh/guide/self-repair"],
        ],
      }
    : {
        nav: ["Route", "Surfaces", "Start"],
        eyebrow: "Agent-computer interface",
        title: "Give agents every interface.",
        lead: "Install once. Search, run, inspect, repair.",
        installTab: "npm",
        agentTab: "Agent prompt",
        copyAction: "Copy",
        secondary: "Open docs",
        copied: "Copied",
        copyFailed: "Select manually",
        brandLabel: "Real software",
        brandTitle: "Where agents start working.",
        routeLabel: "01 · FIND",
        routeTitle: "Find the right operation.",
        routeLead: "State the intent. Select the route. Receive structure.",
        repairLabel: "02 · REPAIR",
        repairTitle: "Run. Inspect. Repair.",
        repairLead: "Adapters stay readable, editable, and ready to run again.",
        repairSteps: ["Run", "Inspect", "Repair"],
        surfaceLabel: "03 · SURFACES",
        surfaceTitle: "One interface. Real software.",
        surfaces: [
          ["Web", "API · DOM · Cookie"],
          ["Browser", "CDP · Network · Snapshot"],
          ["Desktop", "AX · UIA · AT-SPI"],
          ["System", "File · Process · CLI"],
          ["Agents", "MCP · ACP · Skills"],
        ],
        stats: [
          [String(siteIndex.total_sites), "sites & tools"],
          [String(siteIndex.total_commands), "operations"],
          [String(stats.pipeline_step_count), "pipeline actions"],
          [String(stats.test_count), "tests"],
        ],
        startLabel: "04 · START",
        startTitle: "Choose an entry.",
        footerLabel: "Open Agent-Computer Interface",
        license: "Apache-2.0 License",
        entries: [
          ["Install & run", "/guide/getting-started"],
          ["Browse operations", "/reference/sites"],
          ["Connect agents", "/guide/integrations"],
          ["Repair adapters", "/guide/self-repair"],
        ],
      },
);

async function copyHeroCommand() {
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(heroCommand.value);
      copied = true;
    } catch {
      copied = false;
    }
  }

  if (!copied) {
    const fallback = document.createElement("textarea");
    fallback.value = heroCommand.value;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.append(fallback);
    fallback.select();
    copied = document.execCommand("copy");
    fallback.remove();
  }

  if (!copied) {
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
    <nav class="uni-home-nav" aria-label="Homepage">
      <a class="uni-home-brand" :href="withBase(isZh ? '/zh/' : '/')">
        <img :src="withBase('/favicon.png')" alt="" />
        <span>Uni-CLI</span>
      </a>
      <div class="uni-home-nav-links">
        <a href="#route">{{ copy.nav[0] }}</a>
        <a href="#surfaces">{{ copy.nav[1] }}</a>
        <a href="#start">{{ copy.nav[2] }}</a>
      </div>
      <div class="uni-home-nav-actions">
        <a
          href="https://github.com/olo-dot-io/Uni-CLI"
          aria-label="GitHub"
          title="GitHub"
        >
          <img :src="withBase('/brands/github.svg')" alt="" />
        </a>
        <a
          href="https://www.npmjs.com/package/@zenalexa/unicli"
          aria-label="npm"
          title="npm"
        >
          <img :src="withBase('/brands/npm.svg')" alt="" />
        </a>
      </div>
    </nav>

    <section class="uni-landing-hero" aria-labelledby="uni-home-title">
      <img
        class="uni-hero-painting"
        :src="withBase('/green-observatory.webp')"
        alt=""
        aria-hidden="true"
      />

      <div class="uni-hero-copy">
        <header>
          <p class="uni-eyebrow">{{ copy.eyebrow }}</p>
          <h1 id="uni-home-title">{{ copy.title }}</h1>
          <p class="uni-hero-lead">{{ copy.lead }}</p>
        </header>

        <div class="uni-install-panel">
          <div class="uni-command-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              :aria-selected="heroMode === 'install'"
              @click="heroMode = 'install'"
            >
              {{ copy.installTab }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="heroMode === 'agent'"
              @click="heroMode = 'agent'"
            >
              {{ copy.agentTab }}
            </button>
          </div>
          <div class="uni-install-command">
            <code>{{ heroCommand }}</code>
            <button type="button" @click="copyHeroCommand">
              {{
                copyState === "copied"
                  ? copy.copied
                  : copyState === "failed"
                    ? copy.copyFailed
                    : copy.copyAction
              }}
            </button>
          </div>
        </div>

        <a
          class="uni-hero-doc-link"
          :href="
            withBase(
              isZh ? '/zh/guide/getting-started' : '/guide/getting-started',
            )
          "
        >
          {{ copy.secondary }}
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M7 17 17 7M8 7h9v9" />
          </svg>
        </a>
      </div>

      <p class="uni-hero-plate" aria-hidden="true">
        <span>OBSERVATORY 01</span>
        <span>v{{ releaseInfo.version }}</span>
      </p>
      <span class="uni-sr-only" role="status" aria-live="polite">
        {{
          copyState === "idle"
            ? ""
            : copyState === "copied"
              ? copy.copied
              : copy.copyFailed
        }}
      </span>
    </section>

    <section class="uni-brand-orbit" aria-labelledby="uni-brand-title">
      <header>
        <p class="uni-eyebrow">{{ copy.brandLabel }}</p>
        <h2 id="uni-brand-title">{{ copy.brandTitle }}</h2>
      </header>
      <ul>
        <li v-for="brand in brands" :key="brand[0]">
          <img
            :src="withBase(`/brands/${brand[0]}.svg`)"
            :alt="brand[1]"
            :title="brand[1]"
          />
        </li>
      </ul>
    </section>

    <section id="route" class="uni-home-section uni-route-story">
      <article class="uni-art-feature uni-art-feature-archive">
        <img :src="withBase('/orbital-archive.webp')" alt="" />
        <header class="uni-art-copy">
          <p class="uni-eyebrow">{{ copy.routeLabel }}</p>
          <h2>{{ copy.routeTitle }}</h2>
          <p>{{ copy.routeLead }}</p>
        </header>
      </article>
      <OperationReceipt />
    </section>

    <section class="uni-home-section uni-repair-story">
      <article class="uni-art-feature uni-art-feature-repair">
        <img :src="withBase('/orbital-repair.webp')" alt="" />
        <header class="uni-art-copy">
          <p class="uni-eyebrow">{{ copy.repairLabel }}</p>
          <h2>{{ copy.repairTitle }}</h2>
          <p>{{ copy.repairLead }}</p>
          <ol class="uni-repair-steps">
            <li v-for="(step, index) in copy.repairSteps" :key="step">
              <span aria-hidden="true">0{{ index + 1 }}</span>
              {{ step }}
            </li>
          </ol>
        </header>
      </article>
    </section>

    <section
      id="surfaces"
      class="uni-home-section uni-surfaces"
      aria-labelledby="uni-surfaces-title"
    >
      <header class="uni-section-head">
        <p class="uni-eyebrow">{{ copy.surfaceLabel }}</p>
        <h2 id="uni-surfaces-title">{{ copy.surfaceTitle }}</h2>
      </header>

      <div class="uni-surface-list">
        <div v-for="(surface, index) in copy.surfaces" :key="surface[0]">
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path :d="surfaceIcons[index]" />
          </svg>
          <strong>{{ surface[0] }}</strong>
          <code>{{ surface[1] }}</code>
        </div>
      </div>

      <dl class="uni-stat-list">
        <div v-for="stat in copy.stats" :key="stat[1]">
          <dd>{{ stat[0] }}</dd>
          <dt>{{ stat[1] }}</dt>
        </div>
      </dl>
    </section>

    <section
      id="start"
      class="uni-home-section uni-entry-list"
      aria-labelledby="uni-start-title"
    >
      <header class="uni-section-head">
        <p class="uni-eyebrow">{{ copy.startLabel }}</p>
        <h2 id="uni-start-title">{{ copy.startTitle }}</h2>
      </header>
      <ol>
        <li v-for="entry in copy.entries" :key="entry[1]">
          <a :href="withBase(entry[1])">{{ entry[0] }}</a>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M7 17 17 7M8 7h9v9" />
          </svg>
        </li>
      </ol>
    </section>

    <footer class="uni-home-footer">
      <div class="uni-footer-meta">
        <p>{{ copy.footerLabel }}</p>
        <nav aria-label="Footer">
          <a
            href="https://github.com/olo-dot-io/Uni-CLI"
            aria-label="GitHub"
            title="GitHub"
          >
            <img :src="withBase('/brands/github.svg')" alt="" />
          </a>
          <a
            href="https://www.npmjs.com/package/@zenalexa/unicli"
            aria-label="npm"
            title="npm"
          >
            <img :src="withBase('/brands/npm.svg')" alt="" />
          </a>
          <a
            :href="
              withBase(
                isZh ? '/zh/guide/getting-started' : '/guide/getting-started',
              )
            "
            aria-label="Docs"
            title="Docs"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path
                d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4zM9 20V8a4 4 0 0 1 4-4"
              />
            </svg>
          </a>
        </nav>
      </div>
      <p class="uni-footer-word" translate="no">Uni-CLI</p>
      <div class="uni-footer-base">
        <span>{{ copy.license }}</span>
        <span>v{{ releaseInfo.version }}</span>
      </div>
    </footer>
  </main>
</template>
