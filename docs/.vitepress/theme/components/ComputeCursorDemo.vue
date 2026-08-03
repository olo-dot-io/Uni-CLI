<script setup lang="ts">
import visualActionFixture from "../fixtures/compute-visual-action.json";

type ReplayState = "observe" | "move" | "press" | "wait" | "success";

interface ReplayStep {
  state: ReplayState;
  label: string;
  detail: string;
}

const visualAction = visualActionFixture.visual_action;
const pointerPlan = visualAction.pointer_plan;
const start = pointerPlan.from;
const target = visualAction.target.point;
const travelX = Math.round(target.x - start.x);
const travelY = Math.round(target.y - start.y);
const mobileScale = 0.5;

const pointerStyle = {
  "--cursor-start-x": `${start.x}px`,
  "--cursor-start-y": `${start.y}px`,
  "--cursor-travel-x": `${travelX}px`,
  "--cursor-travel-y": `${travelY}px`,
  "--cursor-travel-x-mobile": `${Math.round(travelX * mobileScale)}px`,
  "--cursor-travel-y-mobile": `${Math.round(travelY * mobileScale)}px`,
};

const routeStyle = {
  "--route-left": `${start.x + 12}px`,
  "--route-top": `${start.y + 12}px`,
  "--route-width": `${Math.max(80, travelX + 42)}px`,
  "--route-height": `${Math.max(56, travelY + 12)}px`,
};

const replaySteps: ReplayStep[] = [
  { state: "observe", label: "observe", detail: "refs resolved" },
  {
    state: "move",
    label: "move",
    detail: `${pointerPlan.curve} · ${pointerPlan.samples.length} samples`,
  },
  {
    state: "press",
    label: "press",
    detail: visualAction.dispatch.transport,
  },
  {
    state: "wait",
    label: "overlay",
    detail: `${visualAction.overlay.provider} ${visualAction.overlay.status}`,
  },
  {
    state: "success",
    label: "capture",
    detail: visualAction.post_capture?.ok ? "post state saved" : "not saved",
  },
];
</script>

<template>
  <section
    class="compute-cursor-demo mac-glass-pointer-v1"
    aria-label="Compute visual timeline demo"
  >
    <div class="demo-stage" :style="pointerStyle">
      <div class="demo-toolbar">
        <span />
        <span />
        <span />
      </div>
      <div class="demo-window">
        <div class="demo-sidebar">
          <span />
          <span />
          <span />
        </div>
        <div class="demo-content">
          <div class="demo-search" />
          <div class="demo-grid">
            <span v-for="item in 9" :key="item" />
          </div>
          <button class="demo-target" type="button">Run</button>
        </div>
      </div>

      <div class="demo-route" :style="routeStyle" />
      <div class="demo-pointer" aria-hidden="true">
        <div class="cursor-trace" />
        <div class="cursor-arrow">
          <span class="cursor-arrow-outline" />
          <span class="cursor-arrow-fill" />
          <span class="cursor-arrow-highlight" />
          <span class="cursor-hotspot" />
          <span class="cursor-pressure" />
          <span class="cursor-busy-orbit" />
          <span class="cursor-success" />
        </div>
      </div>
    </div>

    <ol class="demo-steps">
      <li v-for="step in replaySteps" :key="step.state">
        <span class="step-dot" :class="step.state" />
        <strong>{{ step.label }}</strong>
        <span>{{ step.detail }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.compute-cursor-demo {
  margin: 24px 0;
  display: grid;
  gap: 14px;
  --cursor-ink: var(--uni-ink);
  --cursor-paper: var(--uni-paper-raised);
  --cursor-brass: var(--uni-accent);
  --cursor-graphite: var(--uni-muted);
  --cursor-signal: var(--uni-success);
  --cursor-fault: oklch(0.58 0.17 28);
}

.demo-stage {
  position: relative;
  min-height: 360px;
  overflow: hidden;
  border: 0;
  border-radius: 18px;
  background: oklch(0.19 0.008 75);
  box-shadow:
    0 0 0 1px oklch(0 0 0 / 0.12),
    0 18px 44px -30px oklch(0 0 0 / 0.42);
}

.demo-toolbar {
  display: flex;
  gap: 7px;
  padding: 14px 16px;
  border-bottom: 1px solid oklch(1 0 0 / 0.09);
  background: oklch(1 0 0 / 0.035);
}

.demo-toolbar span {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: oklch(0.62 0.01 75);
}

.demo-toolbar span:nth-child(2) {
  background: var(--cursor-brass);
}

.demo-toolbar span:nth-child(3) {
  background: var(--cursor-signal);
}

.demo-window {
  position: absolute;
  inset: 58px 28px 28px;
  display: grid;
  grid-template-columns: 86px 1fr;
  border: 0;
  border-radius: 14px;
  background: var(--cursor-paper);
  box-shadow:
    0 0 0 1px oklch(0 0 0 / 0.09),
    0 24px 70px oklch(0 0 0 / 0.3);
}

.demo-sidebar {
  padding: 24px 16px;
  display: grid;
  align-content: start;
  gap: 12px;
  border-right: 1px solid oklch(0 0 0 / 0.13);
  background: var(--cursor-ink);
}

.demo-sidebar span {
  height: 10px;
  border-radius: 4px;
  background: oklch(1 0 0 / 0.22);
}

.demo-content {
  position: relative;
  padding: 28px;
  display: grid;
  gap: 18px;
  align-content: start;
}

.demo-search {
  width: min(420px, 100%);
  height: 34px;
  border-radius: 10px;
  background: var(--uni-paper-muted);
  box-shadow: inset 0 0 0 1px oklch(0 0 0 / 0.08);
}

.demo-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(52px, 1fr));
  gap: 12px;
  max-width: 460px;
}

.demo-grid span {
  height: 44px;
  border-radius: 10px;
  background: var(--cursor-paper);
  box-shadow: inset 0 0 0 1px oklch(0 0 0 / 0.08);
}

.demo-target {
  position: absolute;
  right: 34px;
  bottom: 34px;
  min-width: 86px;
  height: 40px;
  border: 0;
  border-radius: 10px;
  color: var(--uni-paper-raised);
  font-weight: 720;
  background: var(--cursor-ink);
  box-shadow:
    0 10px 24px oklch(0 0 0 / 0.18),
    inset 0 0 0 1px oklch(1 0 0 / 0.14);
}

.demo-route {
  position: absolute;
  left: var(--route-left);
  top: var(--route-top);
  width: var(--route-width);
  height: var(--route-height);
  border-top: 1px solid oklch(0.61 0.15 39 / 0.52);
  border-right: 1px solid oklch(0.61 0.15 39 / 0.42);
  border-radius: 0 68px 0 0;
  opacity: 0.68;
}

.demo-pointer {
  position: absolute;
  left: var(--cursor-start-x);
  top: var(--cursor-start-y);
  width: 64px;
  height: 68px;
  transform-origin: 0 0;
  animation: pointer-path 7.2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
}

.cursor-trace {
  position: absolute;
  left: -45px;
  top: 26px;
  width: 52px;
  height: 2px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    transparent,
    oklch(0 0 0 / 0.2),
    oklch(0.61 0.15 39 / 0.52)
  );
  transform-origin: right center;
  animation: trace-breathe 7.2s ease-out infinite;
}

.cursor-arrow {
  position: absolute;
  inset: 0;
  filter: drop-shadow(0 9px 10px oklch(0 0 0 / 0.28))
    drop-shadow(0 1px 0 oklch(1 0 0 / 0.42));
}

.cursor-arrow-outline,
.cursor-arrow-fill,
.cursor-arrow-highlight,
.cursor-hotspot,
.cursor-pressure,
.cursor-busy-orbit,
.cursor-success {
  position: absolute;
  pointer-events: none;
}

.cursor-arrow-outline,
.cursor-arrow-fill {
  left: 0;
  top: 0;
  clip-path: polygon(
    0 0,
    0 45px,
    13px 32px,
    21px 55px,
    31px 51px,
    23px 29px,
    43px 29px
  );
}

.cursor-arrow-outline {
  width: 46px;
  height: 58px;
  background: oklch(0.205 0.008 75 / 0.92);
}

.cursor-arrow-fill {
  left: 3px;
  top: 3px;
  width: 38px;
  height: 49px;
  background:
    linear-gradient(145deg, oklch(1 0 0 / 0.92), transparent 34%),
    linear-gradient(
      160deg,
      oklch(1 0 0) 0%,
      oklch(0.97 0.01 88) 62%,
      oklch(0.85 0.025 82) 100%
    );
}

.cursor-arrow-highlight {
  left: 7px;
  top: 7px;
  width: 18px;
  height: 32px;
  border-left: 1px solid oklch(1 0 0 / 0.86);
  transform: skewY(-18deg);
  opacity: 0.8;
}

.cursor-hotspot {
  left: -2px;
  top: -2px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: oklch(0.61 0.15 39 / 0.86);
  box-shadow: 0 0 0 2px oklch(0 0 0 / 0.24);
  opacity: 0.78;
}

.cursor-pressure {
  left: -13px;
  top: -13px;
  width: 30px;
  height: 30px;
  opacity: 0;
  border: 1.5px solid oklch(0.61 0.15 39 / 0.82);
  border-radius: 999px;
  animation: pressure-ring 7.2s ease-out infinite;
}

.cursor-busy-orbit {
  left: -15px;
  top: -15px;
  width: 34px;
  height: 34px;
  opacity: 0;
  border-radius: 999px;
  border: 1px solid transparent;
  border-top-color: oklch(0.97 0.01 88 / 0.82);
  border-left-color: oklch(0.61 0.15 39 / 0.56);
  animation: wait-busy-orbit 7.2s linear infinite;
}

.cursor-success {
  left: 33px;
  top: 21px;
  width: 10px;
  height: 6px;
  opacity: 0;
  border-left: 2px solid var(--cursor-signal);
  border-bottom: 2px solid var(--cursor-signal);
  transform: rotate(-45deg);
  animation: success-mark 7.2s ease-out infinite;
}

.demo-steps {
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  list-style: none;
}

.demo-steps li {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 8px;
  align-items: center;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}

.demo-steps strong {
  font-size: 12px;
  line-height: 1;
}

.demo-steps span:last-child {
  grid-column: 2;
  min-width: 0;
  color: var(--vp-c-text-2);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.step-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--cursor-graphite);
}

.step-dot.move,
.step-dot.press {
  background: var(--cursor-brass);
}

.step-dot.wait {
  background: oklch(0.62 0.01 75);
}

.step-dot.success {
  background: var(--cursor-signal);
}

@keyframes pointer-path {
  0%,
  13% {
    transform: translate(0, 0);
  }
  30%,
  76% {
    transform: translate(var(--cursor-travel-x), var(--cursor-travel-y));
  }
  100% {
    transform: translate(0, 0);
  }
}

@keyframes trace-breathe {
  0%,
  18%,
  84%,
  100% {
    opacity: 0;
    transform: scaleX(0.2);
  }
  28%,
  48% {
    opacity: 0.72;
    transform: scaleX(1);
  }
}

@keyframes wait-busy-orbit {
  0%,
  48%,
  82%,
  100% {
    opacity: 0;
    transform: rotate(0deg);
  }
  54%,
  76% {
    opacity: 1;
    transform: rotate(420deg);
  }
}

@keyframes pressure-ring {
  0%,
  28%,
  100% {
    opacity: 0;
    transform: scale(0.75);
  }
  35% {
    opacity: 0.88;
    transform: scale(0.9);
  }
  47% {
    opacity: 0;
    transform: scale(1.45);
  }
}

@keyframes success-mark {
  0%,
  72%,
  100% {
    opacity: 0;
    transform: translateY(2px) rotate(-45deg);
  }
  78%,
  88% {
    opacity: 1;
    transform: translateY(0) rotate(-45deg);
  }
}

@media (max-width: 700px) {
  .demo-stage {
    min-height: 300px;
  }

  .demo-window {
    inset: 54px 14px 22px;
    grid-template-columns: 54px 1fr;
  }

  .demo-content {
    padding: 18px;
  }

  .demo-route {
    width: calc(var(--route-width) * 0.5);
    height: calc(var(--route-height) * 0.58);
  }

  .demo-pointer {
    animation-name: pointer-path-mobile;
  }

  .demo-steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@keyframes pointer-path-mobile {
  0%,
  13% {
    transform: translate(0, 0);
  }
  30%,
  76% {
    transform: translate(
      var(--cursor-travel-x-mobile),
      var(--cursor-travel-y-mobile)
    );
  }
  100% {
    transform: translate(0, 0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .demo-pointer,
  .cursor-trace,
  .cursor-pressure,
  .cursor-busy-orbit,
  .cursor-success {
    animation-duration: 1ms;
    animation-iteration-count: 1;
  }
}
</style>
