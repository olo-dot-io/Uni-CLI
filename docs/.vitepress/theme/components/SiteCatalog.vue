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
  auth_requirement?: "required" | "optional" | "none";
  auth_setup?: string;
  personalization?: "account" | "feed" | "library" | "network" | "activity";
};

type Adapter = {
  site: string;
  type: string;
  domain?: string;
  auth?: boolean;
  strategy?: string;
  command_count: number;
  personalized_commands?: number;
  personalization_families?: string[];
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
        command.auth_requirement,
        command.auth_setup,
        command.personalization,
      ]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  }),
);
const query = ref("");
const selectedType = ref("all");
const selectedMode = ref<"all" | "personalized" | "auth">("all");
const expandedSites = ref<Set<string>>(new Set());
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
    .filter(
      (adapter) =>
        selectedMode.value === "all" ||
        (selectedMode.value === "personalized" &&
          (adapter.personalized_commands ?? 0) > 0) ||
        (selectedMode.value === "auth" && adapter.auth === true),
    )
    .filter((adapter) => !needle || adapter.searchHaystack.includes(needle));
});
const personalizedSiteCount = computed(
  () =>
    adapters.filter((adapter) => (adapter.personalized_commands ?? 0) > 0)
      .length,
);
const authSiteCount = computed(
  () => adapters.filter((adapter) => adapter.auth).length,
);

function visibleCommands(adapter: Adapter): Command[] {
  if (expandedSites.value.has(adapter.site)) return adapter.commands;
  const personalized = adapter.commands.filter(
    (command) => command.personalization,
  );
  const remaining = adapter.commands.filter(
    (command) => !command.personalization,
  );
  return [...personalized, ...remaining].slice(0, 4);
}

function toggleExpanded(site: string): void {
  const next = new Set(expandedSites.value);
  if (next.has(site)) next.delete(site);
  else next.add(site);
  expandedSites.value = next;
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
        modeFilterAria: "按个人内容和认证要求筛选",
        all: "全部",
        personalized: "个人内容",
        authSites: "需要认证",
        showing: `正在显示 ${filteredAdapters.value.length} 个站点。`,
        commands: "命令",
        personalizedCommands: "个人内容",
        auth: "认证",
        authRequired: "需要",
        authNone: "无",
        showAll: "显示全部命令",
        showLess: "收起命令",
      }
    : {
        eyebrow: "Live generated catalog",
        title: `${siteIndex.total_sites} sites, ${siteIndex.total_commands} commands`,
        intro:
          "Every card below comes from the same adapter manifest that powers CLI discovery. Use it as the public map of what Uni-CLI can operate.",
        filter: "Filter catalog",
        placeholder: "twitter, office, blender, finance...",
        filterAria: "Filter by surface",
        modeFilterAria: "Filter by personalization and authentication",
        all: "All",
        personalized: "Personalized",
        authSites: "Auth required",
        showing: `Showing ${filteredAdapters.value.length} sites.`,
        commands: "commands",
        personalizedCommands: "personalized",
        auth: "auth",
        authRequired: "required",
        authNone: "none",
        showAll: "Show every command",
        showLess: "Show fewer commands",
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

    <div class="site-filter site-mode-filter" :aria-label="copy.modeFilterAria">
      <button
        type="button"
        :class="{ active: selectedMode === 'all' }"
        @click="selectedMode = 'all'"
      >
        {{ copy.all }} <span>{{ adapters.length }}</span>
      </button>
      <button
        type="button"
        :class="{ active: selectedMode === 'personalized' }"
        @click="selectedMode = 'personalized'"
      >
        {{ copy.personalized }}
        <span>{{ personalizedSiteCount }}</span>
      </button>
      <button
        type="button"
        :class="{ active: selectedMode === 'auth' }"
        @click="selectedMode = 'auth'"
      >
        {{ copy.authSites }}
        <span>{{ authSiteCount }}</span>
      </button>
    </div>

    <p class="site-result-count">
      {{ copy.showing }}
    </p>

    <div class="site-grid">
      <article
        v-for="adapter in filteredAdapters"
        :key="adapter.site"
        :id="`site-${adapter.site}`"
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
          <div>
            <dt>{{ copy.personalizedCommands }}</dt>
            <dd>{{ adapter.personalized_commands ?? 0 }}</dd>
          </div>
        </dl>

        <ul class="site-command-list">
          <li v-for="command in visibleCommands(adapter)" :key="command.name">
            <code>{{ command.command }}</code>
            <span>{{
              command.description ?? command.when_to_use ?? command.name
            }}</span>
            <span class="site-command-meta">
              <b v-if="command.personalization">{{
                command.personalization
              }}</b>
              <b v-if="command.auth_requirement === 'required'">{{
                copy.authRequired
              }}</b>
              <code>{{
                `unicli describe ${adapter.site} ${command.name}`
              }}</code>
            </span>
          </li>
        </ul>
        <button
          v-if="adapter.command_count > 4"
          type="button"
          class="site-command-toggle"
          @click="toggleExpanded(adapter.site)"
        >
          {{ expandedSites.has(adapter.site) ? copy.showLess : copy.showAll }}
          <span>{{ adapter.command_count }}</span>
        </button>
      </article>
    </div>
  </section>
</template>
