<!--
@owner docs/.vitepress/theme/components/MissionChapters.vue
@does Render the art-led interface atlas and launch chapters with pointer depth and native scroll expansion.
@needs Generated public counts, VitePress locale/base data, docs/public/interface-atlas.webp, docs/public/launch-deck.webp
@feeds English and Chinese documentation homepages
@breaks Missing artwork or non-native scroll interception would fragment the homepage story.
@invariants Native page scroll remains authoritative and every route stays usable without animation.
@side-effects Updates component-local CSS variables and one SVG displacement attribute from pointer or scroll input.
@perf One damped requestAnimationFrame loop while launch progress changes; O(1) pointer work.
@concurrency Browser-main-thread events are coalesced through requestAnimationFrame.
@test npm run docs:build verifies the compiled public surface
@stability stable
@since 2026-08-03
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useData, withBase } from "vitepress";
import siteIndex from "../../../site-index.json";
import stats from "../../../../stats.json";

const { localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");
const atlasSection = ref<HTMLElement | null>(null);
const launchSection = ref<HTMLElement | null>(null);
const launchPanel = ref<HTMLElement | null>(null);
const displacement = ref<SVGElement | null>(null);
const activeSurface = ref(0);
const activeEntry = ref(0);
const atlasVisible = ref(false);
const launchVisible = ref(false);
const prefersReducedMotion = ref(false);
let launchProgress = 0;
let launchTarget = 0;
let launchFrame = 0;
let launchFrameTime = 0;
let fluidFrame = 0;
let fluidStrength = 0;
let fluidElement: HTMLElement | null = null;
let lastPointerX = 0;
let lastPointerY = 0;
let lastPointerTime = 0;
let observer: IntersectionObserver | undefined;

type TitleSegment = {
  characters: string[];
  offset: number;
  trailingSpace: boolean;
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

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
        surfaceLabel: "03 · SURFACES",
        surfaceTitle: "一座图谱，抵达真实软件。",
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
        startTitle: "选择入口，开始运行。",
        entries: [
          ["安装运行", "/zh/guide/getting-started"],
          ["浏览 operation", "/zh/reference/sites"],
          ["接入 Agent", "/zh/guide/integrations"],
          ["修复与进化", "/zh/guide/self-repair"],
        ],
      }
    : {
        surfaceLabel: "03 · SURFACES",
        surfaceTitle: "One atlas. Real software.",
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
        startTitle: "Choose a route. Start running.",
        entries: [
          ["Install & run", "/guide/getting-started"],
          ["Browse operations", "/reference/sites"],
          ["Connect agents", "/guide/integrations"],
          ["Repair and evolve", "/guide/self-repair"],
        ],
      },
);

function buildTitleSegments(title: string): TitleSegment[] {
  let offset = 0;
  const parts = isZh.value ? Array.from(title) : title.split(" ");
  return parts.map((part, index) => {
    const characters = Array.from(part);
    const segment = {
      characters,
      offset,
      trailingSpace: !isZh.value && index < parts.length - 1,
    };
    offset += characters.length + Number(segment.trailingSpace);
    return segment;
  });
}

const surfaceTitleSegments = computed(() =>
  buildTitleSegments(copy.value.surfaceTitle),
);
const startTitleSegments = computed(() =>
  buildTitleSegments(copy.value.startTitle),
);

function renderLaunchProgress(timestamp: number) {
  const panel = launchPanel.value;
  if (!panel || prefersReducedMotion.value) return;
  const elapsed = launchFrameTime
    ? Math.min(timestamp - launchFrameTime, 40)
    : 16;
  const damping = 1 - Math.exp(-elapsed / 72);
  const next = launchProgress + (launchTarget - launchProgress) * damping;
  launchProgress = Math.abs(launchTarget - next) < 0.0001 ? launchTarget : next;
  panel.style.setProperty("--launch-progress", launchProgress.toFixed(4));
  panel.style.setProperty(
    "--launch-scale",
    (0.955 + launchProgress * 0.045).toFixed(4),
  );
  launchFrameTime = timestamp;

  if (launchProgress !== launchTarget) {
    launchFrame = requestAnimationFrame(renderLaunchProgress);
  } else {
    launchFrame = 0;
    launchFrameTime = 0;
  }
}

function readLaunchProgress(immediate = false) {
  const section = launchSection.value;
  if (!section || prefersReducedMotion.value) return;
  const bounds = section.getBoundingClientRect();
  const travel = Math.max(1, bounds.height - window.innerHeight);
  launchTarget = clamp(-bounds.top / travel);
  if (immediate) launchProgress = launchTarget;
  if (!launchFrame) launchFrame = requestAnimationFrame(renderLaunchProgress);
}

function requestLaunchProgress() {
  readLaunchProgress();
}

function decayFluid() {
  fluidStrength *= 0.84;
  displacement.value?.setAttribute("scale", fluidStrength.toFixed(2));
  fluidElement?.style.setProperty(
    "--chapter-fluid-opacity",
    clamp(fluidStrength / 11, 0, 0.46).toFixed(3),
  );
  if (fluidStrength > 0.16) {
    fluidFrame = requestAnimationFrame(decayFluid);
  } else {
    fluidStrength = 0;
    displacement.value?.setAttribute("scale", "0");
    fluidElement?.style.setProperty("--chapter-fluid-opacity", "0");
    fluidElement = null;
    fluidFrame = 0;
  }
}

function handlePointerMove(event: PointerEvent) {
  if (prefersReducedMotion.value || event.pointerType === "touch") return;
  const element = event.currentTarget as HTMLElement;
  fluidElement = element;
  const bounds = element.getBoundingClientRect();
  const x = clamp((event.clientX - bounds.left) / bounds.width);
  const y = clamp((event.clientY - bounds.top) / bounds.height);
  const now = performance.now();
  const elapsed = Math.max(16, now - lastPointerTime);
  const velocity =
    Math.hypot(event.clientX - lastPointerX, event.clientY - lastPointerY) /
    elapsed;

  element.style.setProperty("--chapter-mouse-x", `${(x * 100).toFixed(2)}%`);
  element.style.setProperty("--chapter-mouse-y", `${(y * 100).toFixed(2)}%`);
  element.style.setProperty(
    "--chapter-shift-x",
    `${((x - 0.5) * -0.7).toFixed(2)}%`,
  );
  element.style.setProperty(
    "--chapter-shift-y",
    `${((y - 0.5) * -0.5).toFixed(2)}%`,
  );
  fluidStrength = Math.max(fluidStrength, clamp(velocity * 4, 0.8, 5));
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  lastPointerTime = now;

  if (fluidFrame) cancelAnimationFrame(fluidFrame);
  displacement.value?.setAttribute("scale", fluidStrength.toFixed(2));
  element.style.setProperty(
    "--chapter-fluid-opacity",
    clamp(fluidStrength / 11, 0, 0.46).toFixed(3),
  );
  fluidFrame = requestAnimationFrame(decayFluid);
}

function resetFluid(event: PointerEvent) {
  const element = event.currentTarget as HTMLElement;
  element.style.setProperty("--chapter-shift-x", "0%");
  element.style.setProperty("--chapter-shift-y", "0%");
  fluidStrength = 0;
  displacement.value?.setAttribute("scale", "0");
  element.style.setProperty("--chapter-fluid-opacity", "0");
  fluidElement = null;
}

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (entry.target === atlasSection.value) atlasVisible.value = true;
        if (entry.target === launchSection.value) launchVisible.value = true;
      }
    },
    { threshold: 0.28 },
  );
  if (atlasSection.value) observer.observe(atlasSection.value);
  if (launchSection.value) observer.observe(launchSection.value);
  readLaunchProgress(true);
  window.addEventListener("scroll", requestLaunchProgress, { passive: true });
  window.addEventListener("resize", requestLaunchProgress, { passive: true });
});

onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener("scroll", requestLaunchProgress);
  window.removeEventListener("resize", requestLaunchProgress);
  if (launchFrame) cancelAnimationFrame(launchFrame);
  if (fluidFrame) cancelAnimationFrame(fluidFrame);
});
</script>

<template>
  <div class="uni-mission-flow">
    <svg class="uni-fluid-defs" aria-hidden="true">
      <filter
        id="uni-chapter-fluid"
        x="-12%"
        y="-12%"
        width="124%"
        height="124%"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.007 0.012"
          numOctaves="1"
          seed="19"
          result="flow"
        />
        <feDisplacementMap
          ref="displacement"
          in="SourceGraphic"
          in2="flow"
          scale="0"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>

    <section
      id="surfaces"
      ref="atlasSection"
      class="uni-atlas-chapter"
      :class="{ 'is-visible': atlasVisible }"
      aria-labelledby="uni-surfaces-title"
    >
      <div
        class="uni-atlas-panel uni-chapter-art"
        :style="{
          '--chapter-scene-shift': `${(activeSurface - 2) * -0.25}%`,
        }"
        @pointermove="handlePointerMove"
        @pointerleave="resetFluid"
      >
        <img
          class="uni-chapter-image"
          :src="withBase('/interface-atlas.webp')"
          alt=""
          loading="lazy"
          decoding="async"
        />
        <img
          class="uni-chapter-image uni-chapter-fluid-image"
          :src="withBase('/interface-atlas.webp')"
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
        />
        <div class="uni-chapter-shade" aria-hidden="true" />

        <header class="uni-chapter-heading">
          <p class="uni-eyebrow">{{ copy.surfaceLabel }}</p>
          <h2 id="uni-surfaces-title" :aria-label="copy.surfaceTitle">
            <span
              v-for="(segment, segmentIndex) in surfaceTitleSegments"
              :key="`${segment.characters.join('')}-${segmentIndex}`"
              class="uni-chapter-word"
              :class="{ 'has-trailing-space': segment.trailingSpace }"
              aria-hidden="true"
            >
              <span
                v-for="(character, characterIndex) in segment.characters"
                :key="`${character}-${characterIndex}`"
                :style="{
                  '--chapter-glyph': segment.offset + characterIndex,
                }"
                >{{ character }}</span
              >
            </span>
          </h2>
        </header>

        <div class="uni-atlas-selector" role="list" aria-label="Surfaces">
          <button
            v-for="(surface, index) in copy.surfaces"
            :key="surface[0]"
            type="button"
            :aria-pressed="activeSurface === index"
            @focus="activeSurface = index"
            @click="activeSurface = index"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path :d="surfaceIcons[index]" />
            </svg>
            <span>
              <strong>{{ surface[0] }}</strong>
              <code>{{ surface[1] }}</code>
            </span>
          </button>
        </div>

        <dl class="uni-atlas-stats">
          <div v-for="stat in copy.stats" :key="stat[1]">
            <dd>{{ stat[0] }}</dd>
            <dt>{{ stat[1] }}</dt>
          </div>
        </dl>
      </div>
    </section>

    <section
      id="start"
      ref="launchSection"
      class="uni-launch-chapter"
      :class="{ 'is-visible': launchVisible }"
      aria-labelledby="uni-start-title"
    >
      <div class="uni-launch-sticky">
        <div
          ref="launchPanel"
          class="uni-launch-panel uni-chapter-art"
          :style="{
            '--chapter-scene-shift': `${(activeEntry - 1.5) * -0.2}%`,
          }"
          @pointermove="handlePointerMove"
          @pointerleave="resetFluid"
        >
          <img
            class="uni-chapter-image"
            :src="withBase('/launch-deck.webp')"
            alt=""
            loading="lazy"
            decoding="async"
          />
          <img
            class="uni-chapter-image uni-chapter-fluid-image"
            :src="withBase('/launch-deck.webp')"
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
          />
          <div class="uni-chapter-shade" aria-hidden="true" />

          <header class="uni-chapter-heading">
            <p class="uni-eyebrow">{{ copy.startLabel }}</p>
            <h2 id="uni-start-title" :aria-label="copy.startTitle">
              <span
                v-for="(segment, segmentIndex) in startTitleSegments"
                :key="`${segment.characters.join('')}-${segmentIndex}`"
                class="uni-chapter-word"
                :class="{ 'has-trailing-space': segment.trailingSpace }"
                aria-hidden="true"
              >
                <span
                  v-for="(character, characterIndex) in segment.characters"
                  :key="`${character}-${characterIndex}`"
                  :style="{
                    '--chapter-glyph': segment.offset + characterIndex,
                  }"
                  >{{ character }}</span
                >
              </span>
            </h2>
          </header>

          <ol class="uni-launch-routes">
            <li v-for="(entry, index) in copy.entries" :key="entry[1]">
              <a
                :href="withBase(entry[1])"
                :aria-current="activeEntry === index ? 'step' : undefined"
                @focus="activeEntry = index"
              >
                <span>{{ String(index + 1).padStart(2, "0") }}</span>
                <strong>{{ entry[0] }}</strong>
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M7 17 17 7M8 7h9v9" />
                </svg>
              </a>
            </li>
          </ol>
        </div>
      </div>
    </section>
  </div>
</template>
