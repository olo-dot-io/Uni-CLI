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
  <section class="compute-cursor-demo" aria-label="Compute visual action demo">
    <div class="demo-stage">
      <div class="demo-window">
        <div class="demo-content">
          <div class="demo-search" />
          <div class="demo-grid">
            <span v-for="item in 6" :key="item" />
          </div>
          <button class="demo-target" type="button">Run</button>
        </div>
      </div>

      <div class="demo-pointer" aria-hidden="true">
        <span class="cursor-arrow-outline" />
        <span class="cursor-arrow-fill" />
      </div>
    </div>

    <ol class="demo-steps">
      <li v-for="step in replaySteps" :key="step.state">
        <strong>{{ step.label }}</strong>
        <span>{{ step.detail }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.compute-cursor-demo {
  display: grid;
  gap: 12px;
  margin: 28px 0;
  padding: 8px;
  border-radius: var(--appica-radius-xl);
  background: var(--appica-background-muted);
}

.demo-stage {
  position: relative;
  min-height: 340px;
  overflow: hidden;
  border-radius: var(--appica-radius-lg);
  background: var(--appica-background-subtle);
}

.demo-window {
  position: absolute;
  inset: 28px;
  border-radius: var(--appica-radius-lg);
  background: var(--appica-background);
  box-shadow: var(--appica-shadow-lg);
}

.demo-content {
  position: relative;
  display: grid;
  gap: 14px;
  align-content: start;
  height: 100%;
  padding: 28px;
}

.demo-search {
  width: min(420px, 72%);
  height: 42px;
  border-radius: var(--appica-radius-sm);
  background: var(--appica-background-muted);
}

.demo-grid {
  display: grid;
  max-width: 480px;
  grid-template-columns: repeat(3, minmax(52px, 1fr));
  gap: 10px;
}

.demo-grid span {
  height: 54px;
  border-radius: var(--appica-radius-sm);
  background: var(--appica-background-subtle);
}

.demo-target {
  position: absolute;
  right: 30px;
  bottom: 30px;
  min-width: 92px;
  height: 44px;
  border: 0;
  border-radius: var(--appica-radius-sm);
  background: var(--appica-primary);
  color: var(--appica-primary-foreground);
  font-size: 14px;
  font-weight: 620;
  box-shadow: var(--appica-shadow-sm);
}

.demo-pointer {
  position: absolute;
  right: 94px;
  bottom: 74px;
  width: 42px;
  height: 52px;
  filter: drop-shadow(0 6px 7px var(--appica-shadow-color));
}

.cursor-arrow-outline,
.cursor-arrow-fill {
  position: absolute;
  left: 0;
  top: 0;
  clip-path: polygon(
    0 0,
    0 41px,
    12px 29px,
    20px 50px,
    29px 46px,
    21px 26px,
    39px 26px
  );
}

.cursor-arrow-outline {
  width: 42px;
  height: 52px;
  background: var(--appica-foreground-intense);
}

.cursor-arrow-fill {
  left: 3px;
  top: 3px;
  width: 34px;
  height: 44px;
  background: var(--appica-background);
}

.demo-steps {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.demo-steps li {
  min-width: 0;
  padding: 12px;
  border-radius: var(--appica-radius-sm);
  background: var(--appica-background);
}

.demo-steps strong,
.demo-steps span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.demo-steps strong {
  color: var(--appica-foreground-intense);
  font-size: 12px;
  line-height: 1.2;
}

.demo-steps span {
  margin-top: 5px;
  color: var(--appica-foreground-muted);
  font-size: 12px;
}

@media (max-width: 700px) {
  .demo-stage {
    min-height: 290px;
  }

  .demo-window {
    inset: 16px;
  }

  .demo-content {
    padding: 18px;
  }

  .demo-grid {
    grid-template-columns: repeat(2, minmax(52px, 1fr));
  }

  .demo-steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
