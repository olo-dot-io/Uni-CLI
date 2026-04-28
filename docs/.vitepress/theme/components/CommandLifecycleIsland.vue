<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useData } from "vitepress";
import "../react/command-island.css";

const host = ref<HTMLElement | null>(null);
const { localeIndex } = useData();
const locale = computed(() => (localeIndex.value === "zh" ? "zh" : "root"));
let cleanup: (() => void) | undefined;

async function mountIsland() {
  if (!host.value) {
    return;
  }

  cleanup?.();
  const { mountCommandIsland } = await import("../react/CommandIsland");
  cleanup = mountCommandIsland(host.value, { locale: locale.value });
}

onMounted(() => {
  void mountIsland();
});

watch(locale, () => {
  void mountIsland();
});

onBeforeUnmount(() => {
  cleanup?.();
});
</script>

<template>
  <div ref="host" class="uni-command-island-host" />
</template>
