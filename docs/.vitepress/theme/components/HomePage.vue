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
import homeOperation from "../../../home-operation.json";
import releaseInfo from "../../../release-info.json";
import siteIndex from "../../../site-index.json";
import stats from "../../../../stats.json";
import OperationReceipt from "./OperationReceipt.vue";

const { localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");
const copyState = ref<"idle" | "copied" | "failed">("idle");
const installCommand = "npm install -g @zenalexa/unicli";
const searchCommand = computed(
  () =>
    `unicli search "${isZh.value ? homeOperation.intent.zh : homeOperation.intent.en.toLowerCase()}"`,
);

const copy = computed(() =>
  isZh.value
    ? {
        eyebrow: "开放式智能体界面",
        title: "一个命令操作所有界面",
        primary: "安装 Uni-CLI",
        secondary: "打开文档",
        copied: "已复制",
        copyFailed: "手动选择",
        commandLabel: "意图",
        stages: [
          ["01", "搜索", `${siteIndex.total_commands} operations`],
          ["02", "选择", homeOperation.candidates.zh[0]],
          ["03", "执行", homeOperation.selected.operator],
          ["04", "结果", "结构化输出"],
        ],
        flowLabel: "实时路径",
        flowTitle: "意图进入，结果返回。",
        surfaceLabel: "可操作范围",
        surfaceTitle: "真实软件，一套接口。",
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
        startLabel: "开始",
        entries: [
          ["安装运行", "/zh/guide/getting-started"],
          ["浏览 operation", "/zh/reference/sites"],
          ["接入 Agent", "/zh/guide/integrations"],
          ["修复 adapter", "/zh/guide/self-repair"],
        ],
        indexText: "智能体索引",
      }
    : {
        eyebrow: "Open agent interface",
        title: "One command Every interface",
        primary: "Install Uni-CLI",
        secondary: "Open docs",
        copied: "Copied",
        copyFailed: "Select manually",
        commandLabel: "Intent",
        stages: [
          ["01", "Search", `${siteIndex.total_commands} operations`],
          ["02", "Select", homeOperation.candidates.en[0]],
          ["03", "Run", homeOperation.selected.operator],
          ["04", "Receipt", "structured output"],
        ],
        flowLabel: "Live route",
        flowTitle: "Intent in. Receipt out.",
        surfaceLabel: "Operating surface",
        surfaceTitle: "Real software. One interface.",
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
        startLabel: "Start",
        entries: [
          ["Install & run", "/guide/getting-started"],
          ["Browse operations", "/reference/sites"],
          ["Connect agents", "/guide/integrations"],
          ["Repair adapters", "/guide/self-repair"],
        ],
        indexText: "Agent index",
      },
);

async function copyInstallCommand() {
  if (!navigator.clipboard) {
    copyState.value = "failed";
    return;
  }

  try {
    await navigator.clipboard.writeText(installCommand);
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
        :src="withBase('/interface-field.webp')"
        alt=""
        width="1920"
        height="1201"
        fetchpriority="high"
      />
      <div class="uni-hero-wash" aria-hidden="true" />

      <div class="uni-product-window">
        <div class="uni-window-bar">
          <a
            class="uni-window-brand"
            href="https://github.com/olo-dot-io/Uni-CLI"
            aria-label="Uni-CLI on GitHub"
          >
            <span translate="no">Uni-CLI</span>
            <small>v{{ releaseInfo.version }}</small>
          </a>
        </div>

        <div class="uni-window-body">
          <header class="uni-hero-copy">
            <p class="uni-eyebrow">{{ copy.eyebrow }}</p>
            <h1 id="uni-home-title">{{ copy.title }}</h1>
          </header>

          <div class="uni-command-composer">
            <span class="uni-composer-label">{{ copy.commandLabel }}</span>
            <code>{{ searchCommand }}</code>
            <a
              :href="
                withBase(isZh ? '/zh/reference/sites' : '/reference/sites')
              "
              :aria-label="copy.secondary"
            >
              <span aria-hidden="true">↑</span>
            </a>
          </div>

          <ol class="uni-stage-list">
            <li v-for="stage in copy.stages" :key="stage[0]">
              <strong>{{ stage[1] }}</strong>
              <small>{{ stage[2] }}</small>
            </li>
          </ol>
        </div>
      </div>

      <div class="uni-hero-actions">
        <button
          type="button"
          class="uni-link-primary"
          @click="copyInstallCommand"
        >
          {{ copy.primary }}
        </button>
        <a
          class="uni-link-secondary"
          :href="
            withBase(
              isZh ? '/zh/guide/getting-started' : '/guide/getting-started',
            )
          "
        >
          {{ copy.secondary }} <span aria-hidden="true">↗</span>
        </a>
      </div>
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

    <section
      class="uni-home-section uni-workflow"
      aria-labelledby="uni-flow-title"
    >
      <header class="uni-section-head">
        <p class="uni-eyebrow">{{ copy.flowLabel }}</p>
        <h2 id="uni-flow-title">{{ copy.flowTitle }}</h2>
      </header>
      <OperationReceipt />
    </section>

    <section
      class="uni-home-section uni-surfaces"
      aria-labelledby="uni-surfaces-title"
    >
      <header class="uni-section-head">
        <p class="uni-eyebrow">{{ copy.surfaceLabel }}</p>
        <h2 id="uni-surfaces-title">{{ copy.surfaceTitle }}</h2>
      </header>

      <div class="uni-surface-list">
        <div v-for="(surface, index) in copy.surfaces" :key="surface[0]">
          <span>0{{ index + 1 }}</span>
          <strong>{{ surface[0] }}</strong>
          <code>{{ surface[1] }}</code>
          <i aria-hidden="true">↗</i>
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
      class="uni-home-section uni-entry-list"
      aria-labelledby="uni-start-title"
    >
      <p class="uni-eyebrow">{{ copy.startLabel }}</p>
      <h2 id="uni-start-title" class="uni-sr-only">{{ copy.startLabel }}</h2>
      <ol>
        <li v-for="(entry, index) in copy.entries" :key="entry[1]">
          <span>0{{ index + 1 }}</span>
          <a :href="withBase(entry[1])">{{ entry[0] }}</a>
          <b aria-hidden="true">↗</b>
        </li>
      </ol>
    </section>

    <footer class="uni-index-line">
      <span>{{ copy.indexText }}</span>
      <a :href="withBase('/llms.txt')">llms.txt</a>
      <a :href="withBase('/llms-full.txt')">llms-full.txt</a>
      <a href="https://github.com/olo-dot-io/Uni-CLI">GitHub ↗</a>
    </footer>
  </main>
</template>
