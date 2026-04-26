<script setup lang="ts">
import { computed } from "vue";
import { useData, withBase } from "vitepress";
import siteIndex from "../../../site-index.json";

type Adapter = {
  type: string;
};

const adapters = siteIndex.sites as Adapter[];
const { localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");
const surfaceCounts = adapters.reduce<Record<string, number>>(
  (counts, adapter) => {
    counts[adapter.type] = (counts[adapter.type] ?? 0) + 1;
    return counts;
  },
  {},
);

const surfaceCopy = {
  root: [
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
  ],
  zh: [
    { label: "Web API", key: "web-api", detail: "HTTP、Cookie、公开端点" },
    { label: "桌面", key: "desktop", detail: "macOS 和本地应用控制" },
    { label: "浏览器", key: "browser", detail: "CDP、快照、请求拦截" },
    { label: "桥接", key: "bridge", detail: "外部 CLI 和智能体后端" },
    { label: "服务", key: "service", detail: "云服务和托管工具" },
  ],
};

const surfaces = computed(() =>
  isZh.value ? surfaceCopy.zh : surfaceCopy.root,
);

const headlineStats = computed(() =>
  isZh.value
    ? [
        { value: siteIndex.total_sites, label: "站点" },
        { value: siteIndex.total_commands, label: "命令" },
        { value: surfaces.value.length, label: "接口类型" },
        { value: "v2", label: "AgentEnvelope" },
      ]
    : [
        { value: siteIndex.total_sites, label: "sites" },
        { value: siteIndex.total_commands, label: "commands" },
        { value: surfaces.value.length, label: "surface families" },
        { value: "v2", label: "agent envelope" },
      ],
);
</script>

<template>
  <section
    class="uni-home-section uni-home-stats"
    aria-labelledby="stats-title"
  >
    <div>
      <p class="uni-eyebrow">
        {{ isZh ? "一个目录，连接多种软件接口" : "One catalog, many surfaces" }}
      </p>
      <h2 id="stats-title">
        {{
          isZh
            ? "从一句意图搜索，到一条可运行命令。"
            : "From one intent search to a runnable command."
        }}
      </h2>
      <p>
        {{
          isZh
            ? "Uni-CLI 把第一次交互做小：先搜目录，再选最窄的命令，运行后拿到结构化结果；失败时也会给出可修复的错误。"
            : "Uni-CLI keeps the first interaction small: search the catalog, choose the narrow command, run it, and get a structured result or a repairable error."
        }}
      </p>
    </div>

    <div
      class="uni-stat-grid"
      :aria-label="isZh ? '目录统计' : 'Catalog stats'"
    >
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
        :href="withBase(isZh ? '/zh/reference/sites' : '/reference/sites')"
      >
        <span>{{ surface.label }}</span>
        <strong>{{ surfaceCounts[surface.key] ?? 0 }}</strong>
        <small>{{ surface.detail }}</small>
      </a>
    </div>
  </section>
</template>
