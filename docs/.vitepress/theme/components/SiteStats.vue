<script setup lang="ts">
import { withBase } from "vitepress";
import siteIndex from "../../../site-index.json";

type Adapter = {
  type: string;
};

const adapters = siteIndex.sites as Adapter[];
const surfaceCounts = adapters.reduce<Record<string, number>>(
  (counts, adapter) => {
    counts[adapter.type] = (counts[adapter.type] ?? 0) + 1;
    return counts;
  },
  {},
);

const surfaces = [
  {
    label: "Web APIs",
    key: "web-api",
    detail: "HTTP, cookies, public endpoints",
  },
  { label: "Desktop", key: "desktop", detail: "macOS and local app control" },
  { label: "Browser", key: "browser", detail: "CDP, snapshots, intercepts" },
  {
    label: "Bridge",
    key: "bridge",
    detail: "External CLIs and agent backends",
  },
  { label: "Service", key: "service", detail: "Cloud and hosted tools" },
];

const headlineStats = [
  { value: siteIndex.total_sites, label: "sites" },
  { value: siteIndex.total_commands, label: "commands" },
  { value: surfaces.length, label: "surface families" },
  { value: "v2", label: "agent envelope" },
];
</script>

<template>
  <section
    class="uni-home-section uni-home-stats"
    aria-labelledby="stats-title"
  >
    <div>
      <p class="uni-eyebrow">One catalog, many surfaces</p>
      <h2 id="stats-title">From one intent search to a runnable command.</h2>
      <p>
        Uni-CLI keeps the first interaction small: search the catalog, choose
        the narrow command, run it, and get a structured result or a repairable
        error.
      </p>
    </div>

    <div class="uni-stat-grid" aria-label="Catalog stats">
      <div v-for="stat in headlineStats" :key="stat.label" class="uni-stat">
        <strong>{{ stat.value }}</strong>
        <span>{{ stat.label }}</span>
      </div>
    </div>

    <div class="uni-surface-grid">
      <a
        v-for="surface in surfaces"
        :key="surface.key"
        class="uni-surface"
        :href="withBase('/reference/sites')"
      >
        <span>{{ surface.label }}</span>
        <strong>{{ surfaceCounts[surface.key] ?? 0 }}</strong>
        <small>{{ surface.detail }}</small>
      </a>
    </div>
  </section>
</template>
