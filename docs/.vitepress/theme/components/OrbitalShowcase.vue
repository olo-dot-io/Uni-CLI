<!--
@owner docs/.vitepress/theme/components/OrbitalShowcase.vue
@does Map native page scroll and pointer movement onto a four-scene orbital product story.
@needs VitePress locale/base data, browser scroll and pointer events, docs/public/orbital-*.webp
@feeds English and Chinese documentation homepages
@breaks Missing artwork or unbounded animation work would leave a blank or sluggish homepage chapter.
@invariants Native scrolling remains authoritative; reduced-motion and coarse-pointer users receive a static readable sequence.
@side-effects Updates component-local CSS variables and one SVG displacement attribute while the scene is active.
@perf One requestAnimationFrame per scroll or pointer frame, O(4) card transforms.
@concurrency Browser-main-thread events are coalesced through requestAnimationFrame.
@test npm run docs:build verifies the compiled public surface
@stability stable
@since 2026-08-03
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useData, withBase } from "vitepress";

const { localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");
const stage = ref<HTMLElement | null>(null);
const displacement = ref<SVGElement | null>(null);
const progress = ref(0);
const activeScene = ref(0);
const prefersReducedMotion = ref(false);
let scrollFrame = 0;
let targetProgress = 0;
let lastScrollTime = 0;
let fluidFrame = 0;
let fluidStrength = 0;
let lastPointerX = 0;
let lastPointerY = 0;
let lastPointerTime = 0;

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const scenes = computed(() =>
  isZh.value
    ? [
        {
          index: "01",
          label: "FIND",
          title: "找到 operation。",
          detail: "从意图开始。",
          image: "/orbital-archive.webp",
        },
        {
          index: "02",
          label: "SELECT",
          title: "选择真实路径。",
          detail: "API、DOM、桌面或系统。",
          image: "/orbital-relay.webp",
        },
        {
          index: "03",
          label: "RUN",
          title: "执行并收回结构。",
          detail: "结果可以直接交给 Agent。",
          image: "/orbital-memory.webp",
        },
        {
          index: "04",
          label: "REPAIR",
          title: "界面变化，路径继续。",
          detail: "读取、修改、再次运行。",
          image: "/orbital-repair.webp",
        },
      ]
    : [
        {
          index: "01",
          label: "FIND",
          title: "Find the operation.",
          detail: "Begin with intent.",
          image: "/orbital-archive.webp",
        },
        {
          index: "02",
          label: "SELECT",
          title: "Choose the real route.",
          detail: "API, DOM, desktop, or system.",
          image: "/orbital-relay.webp",
        },
        {
          index: "03",
          label: "RUN",
          title: "Run. Bring back structure.",
          detail: "Ready for the agent to use.",
          image: "/orbital-memory.webp",
        },
        {
          index: "04",
          label: "REPAIR",
          title: "Interfaces move. Routes endure.",
          detail: "Read, edit, run again.",
          image: "/orbital-repair.webp",
        },
      ],
);

const sectionCopy = computed(() =>
  isZh.value
    ? { label: "01 · ORBITAL SEQUENCE", title: "从意图到真实软件。" }
    : {
        label: "01 · ORBITAL SEQUENCE",
        title: "From intent to real software.",
      },
);

const position = computed(() => progress.value * (scenes.value.length - 1));
const expansion = computed(() => clamp((progress.value - 0.86) / 0.14));

function cardStyle(index: number) {
  const delta = index - position.value;
  const distance = Math.abs(delta);
  return {
    "--orbit-delta": delta.toFixed(4),
    "--orbit-distance": distance.toFixed(4),
    "--orbit-opacity": String(clamp(1.12 - distance * 0.54, 0, 1)),
    "--orbit-copy-opacity": String(clamp(1 - distance * 2.2, 0, 1)),
    "--orbit-z": String(40 - Math.round(distance * 10)),
  };
}

function renderScrollProgress(timestamp: number) {
  const element = stage.value;
  if (!element || prefersReducedMotion.value) return;

  const elapsed = lastScrollTime
    ? Math.min(timestamp - lastScrollTime, 40)
    : 16;
  const damping = 1 - Math.exp(-elapsed / 68);
  const next = progress.value + (targetProgress - progress.value) * damping;
  progress.value =
    Math.abs(targetProgress - next) < 0.0001 ? targetProgress : next;
  activeScene.value = Math.round(position.value);
  element.style.setProperty("--orbit-progress", progress.value.toFixed(4));
  element.style.setProperty("--orbit-expand", expansion.value.toFixed(4));
  element.style.setProperty(
    "--orbit-parallax",
    `${((progress.value - 0.5) * -10).toFixed(3)}%`,
  );

  lastScrollTime = timestamp;
  if (progress.value !== targetProgress) {
    scrollFrame = requestAnimationFrame(renderScrollProgress);
  } else {
    scrollFrame = 0;
    lastScrollTime = 0;
  }
}

function readScrollProgress(immediate = false) {
  const element = stage.value;
  if (!element || prefersReducedMotion.value) return;
  const bounds = element.getBoundingClientRect();
  const travel = Math.max(1, bounds.height - window.innerHeight);
  targetProgress = clamp(-bounds.top / travel);

  if (immediate) {
    progress.value = targetProgress;
    lastScrollTime = 0;
  }

  if (!scrollFrame) scrollFrame = requestAnimationFrame(renderScrollProgress);
}

function requestScrollProgress() {
  readScrollProgress();
}

function decayFluid() {
  fluidStrength *= 0.86;
  displacement.value?.setAttribute("scale", fluidStrength.toFixed(2));
  if (fluidStrength > 0.18) {
    fluidFrame = requestAnimationFrame(decayFluid);
  } else {
    fluidStrength = 0;
    displacement.value?.setAttribute("scale", "0");
    fluidFrame = 0;
  }
}

function handlePointerMove(event: PointerEvent) {
  const element = stage.value;
  if (!element || prefersReducedMotion.value || event.pointerType === "touch") {
    return;
  }

  const activeCard = element.querySelector<HTMLElement>(
    ".uni-orbit-card.is-active",
  );
  const bounds =
    activeCard?.getBoundingClientRect() ?? element.getBoundingClientRect();
  const x = clamp((event.clientX - bounds.left) / bounds.width);
  const y = clamp((event.clientY - bounds.top) / bounds.height);
  const now = performance.now();
  const elapsed = Math.max(16, now - lastPointerTime);
  const velocity =
    Math.hypot(event.clientX - lastPointerX, event.clientY - lastPointerY) /
    elapsed;

  element.style.setProperty("--orbit-mouse-x", `${(x * 100).toFixed(2)}%`);
  element.style.setProperty("--orbit-mouse-y", `${(y * 100).toFixed(2)}%`);
  element.style.setProperty(
    "--orbit-tilt-x",
    `${((0.5 - y) * 2.4).toFixed(2)}deg`,
  );
  element.style.setProperty(
    "--orbit-tilt-y",
    `${((x - 0.5) * 3.2).toFixed(2)}deg`,
  );
  fluidStrength = Math.max(fluidStrength, clamp(velocity * 12, 3, 16));
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  lastPointerTime = now;

  if (fluidFrame) cancelAnimationFrame(fluidFrame);
  displacement.value?.setAttribute("scale", fluidStrength.toFixed(2));
  fluidFrame = requestAnimationFrame(decayFluid);
}

function resetPointer() {
  stage.value?.style.setProperty("--orbit-tilt-x", "0deg");
  stage.value?.style.setProperty("--orbit-tilt-y", "0deg");
  fluidStrength = 0;
  displacement.value?.setAttribute("scale", "0");
}

function scrollToScene(index: number) {
  const element = stage.value;
  if (!element) return;
  const top = window.scrollY + element.getBoundingClientRect().top;
  const travel = element.offsetHeight - window.innerHeight;
  window.scrollTo({
    top: top + (travel * index) / (scenes.value.length - 1),
    behavior: prefersReducedMotion.value ? "auto" : "smooth",
  });
}

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  readScrollProgress(true);
  window.addEventListener("scroll", requestScrollProgress, { passive: true });
  window.addEventListener("resize", requestScrollProgress, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("scroll", requestScrollProgress);
  window.removeEventListener("resize", requestScrollProgress);
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
  if (fluidFrame) cancelAnimationFrame(fluidFrame);
});
</script>

<template>
  <section
    id="route"
    ref="stage"
    class="uni-orbit-stage"
    aria-labelledby="uni-orbit-title"
    @pointermove="handlePointerMove"
    @pointerleave="resetPointer"
  >
    <svg class="uni-fluid-defs" aria-hidden="true">
      <filter id="uni-orbit-fluid" x="-15%" y="-15%" width="130%" height="130%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.008 0.015"
          numOctaves="1"
          seed="7"
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

    <div class="uni-orbit-sticky">
      <header class="uni-orbit-heading">
        <p class="uni-eyebrow">{{ sectionCopy.label }}</p>
        <h2 id="uni-orbit-title">{{ sectionCopy.title }}</h2>
      </header>

      <div class="uni-orbit-ring">
        <article
          v-for="(scene, index) in scenes"
          :key="scene.label"
          class="uni-orbit-card"
          :class="{
            'is-active': activeScene === index,
            'is-final': index === scenes.length - 1,
          }"
          :style="cardStyle(index)"
        >
          <img
            class="uni-orbit-image"
            :src="withBase(scene.image)"
            alt=""
            loading="lazy"
            decoding="async"
          />
          <img
            class="uni-orbit-image uni-orbit-fluid-image"
            :src="withBase(scene.image)"
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
          />
          <div class="uni-orbit-card-copy">
            <p>{{ scene.index }} · {{ scene.label }}</p>
            <h3>{{ scene.title }}</h3>
            <span>{{ scene.detail }}</span>
          </div>
        </article>
      </div>

      <nav class="uni-orbit-index" :aria-label="sectionCopy.title">
        <button
          v-for="(scene, index) in scenes"
          :key="scene.index"
          type="button"
          :aria-current="activeScene === index ? 'step' : undefined"
          @click="scrollToScene(index)"
        >
          <span>{{ scene.index }}</span>
          {{ scene.label }}
        </button>
      </nav>
    </div>
  </section>
</template>
