<script setup lang="ts">
import { computed, ref } from "vue";
import { useData } from "vitepress";
import siteIndex from "../../../site-index.json";

type Command = {
  name: string;
  description?: string;
  when_to_use?: string;
  command: string;
  auth?: boolean;
  browser?: boolean;
};

type Adapter = {
  site: string;
  type: string;
  domain?: string;
  auth?: boolean;
  strategy?: string;
  command_count: number;
  commands: Command[];
};

type IndexedAdapter = Adapter & {
  searchHaystack: string;
};

const adapters = (siteIndex.sites as Adapter[]).map<IndexedAdapter>(
  (adapter) => ({
    ...adapter,
    searchHaystack: [
      adapter.site,
      adapter.domain,
      adapter.type,
      adapter.strategy,
      ...adapter.commands.flatMap((command) => [
        command.name,
        command.description,
        command.when_to_use,
        command.command,
      ]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  }),
);
const query = ref("");
const selectedType = ref("all");
const { localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");

const typeOrder = ["web-api", "desktop", "browser", "bridge", "service"];
const typeLabelsRoot: Record<string, string> = {
  "web-api": "Web API",
  desktop: "Desktop",
  browser: "Browser",
  bridge: "Bridge",
  service: "Service",
};
const typeLabelsZh: Record<string, string> = {
  "web-api": "Web API",
  desktop: "桌面",
  browser: "浏览器",
  bridge: "桥接",
  service: "服务",
};
const typeLabels = computed(() => (isZh.value ? typeLabelsZh : typeLabelsRoot));

const types = computed(() =>
  typeOrder
    .filter((type) => adapters.some((adapter) => adapter.type === type))
    .map((type) => ({
      type,
      label: typeLabels.value[type] ?? type,
      count: adapters.filter((adapter) => adapter.type === type).length,
    })),
);

const filteredAdapters = computed(() => {
  const needle = query.value.trim().toLowerCase();

  return adapters
    .filter(
      (adapter) =>
        selectedType.value === "all" || adapter.type === selectedType.value,
    )
    .filter((adapter) => !needle || adapter.searchHaystack.includes(needle));
});

function sampleCommands(adapter: Adapter): Command[] {
  return adapter.commands.slice(0, 4);
}

const copy = computed(() =>
  isZh.value
    ? {
        eyebrow: "实时生成的目录",
        title: `${siteIndex.total_sites} 个站点，${siteIndex.total_commands} 条命令`,
        intro:
          "下面每张卡片都来自驱动 CLI 搜索的同一份适配器 manifest。它是 Uni-CLI 当前能操作哪些软件的公开地图。",
        filter: "筛选目录",
        placeholder: "twitter、office、blender、finance...",
        filterAria: "按接口类型筛选",
        all: "全部",
        showing: `正在显示 ${filteredAdapters.value.length} 个站点。`,
        commands: "命令",
        auth: "认证",
        authRequired: "需要",
        authNone: "无",
      }
    : {
        eyebrow: "Live generated catalog",
        title: `${siteIndex.total_sites} sites, ${siteIndex.total_commands} commands`,
        intro:
          "Every card below comes from the same adapter manifest that powers CLI discovery. Use it as the public map of what Uni-CLI can operate.",
        filter: "Filter catalog",
        placeholder: "twitter, office, blender, finance...",
        filterAria: "Filter by surface",
        all: "All",
        showing: `Showing ${filteredAdapters.value.length} sites.`,
        commands: "commands",
        auth: "auth",
        authRequired: "required",
        authNone: "none",
      },
);
</script>

<template>
  <section class="site-catalog" aria-labelledby="site-catalog-title">
    <div class="site-catalog-header">
      <div>
        <p class="uni-eyebrow">{{ copy.eyebrow }}</p>
        <h2 id="site-catalog-title">{{ copy.title }}</h2>
        <p>{{ copy.intro }}</p>
      </div>
      <label class="site-search">
        <span>{{ copy.filter }}</span>
        <input
          v-model="query"
          type="search"
          :placeholder="copy.placeholder"
          autocomplete="off"
        />
      </label>
    </div>

    <div class="site-filter" :aria-label="copy.filterAria">
      <button
        type="button"
        :class="{ active: selectedType === 'all' }"
        @click="selectedType = 'all'"
      >
        {{ copy.all }} <span>{{ adapters.length }}</span>
      </button>
      <button
        v-for="type in types"
        :key="type.type"
        type="button"
        :class="{ active: selectedType === type.type }"
        @click="selectedType = type.type"
      >
        {{ type.label }} <span>{{ type.count }}</span>
      </button>
    </div>

    <p class="site-result-count">
      {{ copy.showing }}
    </p>

    <div class="site-grid">
      <article
        v-for="adapter in filteredAdapters"
        :key="adapter.site"
        class="site-card"
      >
        <div class="site-card-top">
          <div>
            <h3>{{ adapter.site }}</h3>
            <p>
              {{ adapter.domain ?? typeLabels[adapter.type] ?? adapter.type }}
            </p>
          </div>
          <span class="site-pill">{{
            typeLabels[adapter.type] ?? adapter.type
          }}</span>
        </div>

        <dl class="site-meta">
          <div>
            <dt>{{ copy.commands }}</dt>
            <dd>{{ adapter.command_count }}</dd>
          </div>
          <div>
            <dt>{{ copy.auth }}</dt>
            <dd>
              {{
                adapter.auth
                  ? (adapter.strategy ?? copy.authRequired)
                  : copy.authNone
              }}
            </dd>
          </div>
        </dl>

        <ul class="site-command-list">
          <li v-for="command in sampleCommands(adapter)" :key="command.name">
            <code>{{ command.command }}</code>
            <span>{{
              command.description ?? command.when_to_use ?? command.name
            }}</span>
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>
