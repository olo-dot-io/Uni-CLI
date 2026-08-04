<!--
@owner docs/.vitepress/theme/components/HomePage.vue
@does Render the bilingual public landing page as a compact, product-led interface.
@needs docs/release-info.json, docs/site-index.json, stats.json, VitePress locale/base data, Lenis, browser Clipboard API
@feeds English and Chinese documentation homepages
@breaks Stale product claims or generated counts misrepresent the public Agent-Computer Interface surface.
@invariants English and Chinese copy share one information architecture and all displayed counts come from generated sources.
@side-effects Interpolates homepage wheel scrolling, copies the install command on explicit user action, and updates local reactive state.
@perf One Lenis requestAnimationFrame loop while the homepage is mounted; O(1) over static copy and generated scalar counts per render.
@concurrency Browser-main-thread Vue reactivity; clipboard completion may resolve asynchronously.
@test npm run docs:build verifies the compiled public surface
@stability stable
@since 2026-08-02
-->
<script setup lang="ts">
import Lenis from "lenis";
import { computed, onBeforeUnmount, onMounted, provide, ref } from "vue";
import { useData, withBase } from "vitepress";
import releaseInfo from "../../../release-info.json";
import { homeScrollToKey } from "../home-scroll";
import MissionChapters from "./MissionChapters.vue";
import OperationReceipt from "./OperationReceipt.vue";
import OrbitalShowcase from "./OrbitalShowcase.vue";

const { isDark, localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");
const copyState = ref<"idle" | "copied" | "failed">("idle");
const heroMode = ref<"install" | "agent">("install");
let homepageScroll: Lenis | undefined;
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

const copy = computed(() =>
  isZh.value
    ? {
        nav: ["文档", "操作", "架构"],
        eyebrow: "开放式 Agent-Computer Interface",
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
        receiptLabel: "02 · RECEIPT",
        receiptTitle: "结构化结果返回。",
        footerLabel: "开放式 Agent-Computer Interface",
        license: "Apache-2.0 许可证",
      }
    : {
        nav: ["Docs", "Operations", "Architecture"],
        eyebrow: "Open agent-computer interface",
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
        receiptLabel: "02 · RECEIPT",
        receiptTitle: "Structure comes back.",
        footerLabel: "Open Agent-Computer Interface",
        license: "Apache-2.0 License",
      },
);
const titleWords = computed(() => {
  let offset = 0;
  return copy.value.title.split(" ").map((word) => {
    const item = { characters: Array.from(word), offset };
    offset += item.characters.length + 1;
    return item;
  });
});

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

function setHeroMode(mode: "install" | "agent") {
  heroMode.value = mode;
  copyState.value = "idle";
}

function toggleTheme() {
  isDark.value = !isDark.value;
}

provide(homeScrollToKey, (top) => {
  if (homepageScroll) {
    homepageScroll.scrollTo(top);
    return;
  }

  window.scrollTo({
    top,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
});

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  homepageScroll = new Lenis({
    autoRaf: true,
    lerp: 0.09,
    smoothWheel: true,
    syncTouch: false,
  });
});

onBeforeUnmount(() => {
  homepageScroll?.destroy();
  homepageScroll = undefined;
});
</script>

<template>
  <main class="uni-docs-home">
    <nav class="uni-home-nav" aria-label="Homepage">
      <a class="uni-home-brand" :href="withBase(isZh ? '/zh/' : '/')">
        <img :src="withBase('/favicon.png')" alt="" />
        <span>Uni-CLI</span>
      </a>
      <div class="uni-home-nav-links">
        <a :href="withBase(isZh ? '/zh/guide/' : '/guide/')">
          {{ copy.nav[0] }}
        </a>
        <a :href="withBase(isZh ? '/zh/reference/sites' : '/reference/sites')">
          {{ copy.nav[1] }}
        </a>
        <a :href="withBase(isZh ? '/zh/ARCHITECTURE' : '/ARCHITECTURE')">
          {{ copy.nav[2] }}
        </a>
      </div>
      <div class="uni-home-nav-actions">
        <button
          class="uni-home-theme"
          type="button"
          :aria-label="isDark ? 'Use light theme' : 'Use dark theme'"
          @click="toggleTheme"
        >
          <svg v-if="isDark" aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="4" />
            <path
              d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
            />
          </svg>
          <svg v-else aria-hidden="true" viewBox="0 0 24 24">
            <path
              d="M20.3 15.2A8.5 8.5 0 0 1 8.8 3.7 8.5 8.5 0 1 0 20.3 15.2Z"
            />
          </svg>
        </button>
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
          <h1 id="uni-home-title" :aria-label="copy.title">
            <span
              v-for="(word, wordIndex) in titleWords"
              :key="`${word.characters.join('')}-${wordIndex}`"
              class="uni-title-word"
              aria-hidden="true"
            >
              <span
                v-for="(character, characterIndex) in word.characters"
                :key="`${character}-${characterIndex}`"
                :style="{
                  '--glyph-index': word.offset + characterIndex,
                }"
                >{{ character }}</span
              >
            </span>
          </h1>
          <p class="uni-hero-lead">{{ copy.lead }}</p>
        </header>

        <div class="uni-command-console">
          <div class="uni-command-head">
            <div class="uni-command-tabs" role="tablist">
              <button
                type="button"
                id="uni-install-tab"
                role="tab"
                aria-controls="uni-hero-command"
                :aria-selected="heroMode === 'install'"
                @click="setHeroMode('install')"
              >
                {{ copy.installTab }}
              </button>
              <button
                type="button"
                id="uni-agent-tab"
                role="tab"
                aria-controls="uni-hero-command"
                :aria-selected="heroMode === 'agent'"
                @click="setHeroMode('agent')"
              >
                {{ copy.agentTab }}
              </button>
            </div>
          </div>
          <Transition name="uni-command-swap" mode="out-in">
            <div
              id="uni-hero-command"
              :key="heroMode"
              class="uni-install-command"
              role="tabpanel"
              :aria-labelledby="
                heroMode === 'install' ? 'uni-install-tab' : 'uni-agent-tab'
              "
            >
              <span class="uni-command-prompt" aria-hidden="true">$</span>
              <code>{{ heroCommand }}</code>
              <button
                type="button"
                :aria-label="copy.copyAction"
                @click="copyHeroCommand"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path v-if="copyState === 'copied'" d="m5 12 4 4L19 6" />
                  <path v-else d="M9 8h10v11H9zM5 15V5h10" />
                </svg>
                <span>{{
                  copyState === "copied"
                    ? copy.copied
                    : copyState === "failed"
                      ? copy.copyFailed
                      : copy.copyAction
                }}</span>
              </button>
            </div>
          </Transition>
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

    <OrbitalShowcase />

    <section
      class="uni-home-section uni-route-receipt"
      aria-labelledby="uni-receipt-title"
    >
      <header class="uni-section-head uni-receipt-head">
        <p class="uni-eyebrow">{{ copy.receiptLabel }}</p>
        <h2 id="uni-receipt-title">{{ copy.receiptTitle }}</h2>
      </header>
      <OperationReceipt />
    </section>

    <MissionChapters />

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
      <p
        class="uni-footer-word"
        translate="no"
        :style="{
          backgroundImage: `url(${withBase('/interface-atlas.webp')})`,
        }"
      >
        Uni-CLI
      </p>
      <div class="uni-footer-base">
        <span>{{ copy.license }}</span>
        <span>v{{ releaseInfo.version }}</span>
      </div>
    </footer>
  </main>
</template>
