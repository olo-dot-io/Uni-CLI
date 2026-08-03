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
const copy = computed(() =>
  isZh.value
    ? {
        eyebrow: "Agent-Computer Interface",
        title: "把所有界面交给 Agent。",
        lead: "安装一次。搜索、执行、检查、修复。",
        installTab: "npm",
        agentTab: "Agent 指令",
        copyAction: "复制",
        secondary: "打开文档",
        github: "GitHub",
        copied: "已复制",
        copyFailed: "手动选择",
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
        eyebrow: "Agent-computer interface",
        title: "Give agents every interface.",
        lead: "Install once. Search, run, inspect, repair.",
        installTab: "npm",
        agentTab: "Agent prompt",
        copyAction: "Copy",
        secondary: "Open docs",
        github: "GitHub",
        copied: "Copied",
        copyFailed: "Select manually",
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

        <div class="uni-hero-actions">
          <a
            :href="
              withBase(
                isZh ? '/zh/guide/getting-started' : '/guide/getting-started',
              )
            "
          >
            {{ copy.secondary }} <span aria-hidden="true">↗</span>
          </a>
          <a href="https://github.com/olo-dot-io/Uni-CLI">
            {{ copy.github }} <span aria-hidden="true">↗</span>
          </a>
        </div>
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

    <footer class="uni-home-footer">
      <div class="uni-footer-meta">
        <p>{{ copy.footerLabel }}</p>
        <nav aria-label="Footer">
          <a href="https://github.com/olo-dot-io/Uni-CLI">GitHub</a>
          <a href="https://www.npmjs.com/package/@zenalexa/unicli">npm</a>
          <a
            :href="
              withBase(
                isZh ? '/zh/guide/getting-started' : '/guide/getting-started',
              )
            "
          >
            Docs
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
