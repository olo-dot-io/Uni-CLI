<script setup lang="ts">
import { computed, ref } from "vue";
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

const typeOrder = ["web-api", "desktop", "browser", "bridge", "service"];
const typeLabels: Record<string, string> = {
  "web-api": "Web API",
  desktop: "Desktop",
  browser: "Browser",
  bridge: "Bridge",
  service: "Service",
};

const types = computed(() =>
  typeOrder
    .filter((type) => adapters.some((adapter) => adapter.type === type))
    .map((type) => ({
      type,
      label: typeLabels[type] ?? type,
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
</script>

<template>
  <section class="site-catalog" aria-labelledby="site-catalog-title">
    <div class="site-catalog-header">
      <div>
        <p class="uni-eyebrow">Live generated catalog</p>
        <h2 id="site-catalog-title">
          {{ siteIndex.total_sites }} sites,
          {{ siteIndex.total_commands }} commands
        </h2>
        <p>
          Every card below comes from the same adapter manifest that powers CLI
          discovery. Use it as the public map of what Uni-CLI can operate.
        </p>
      </div>
      <label class="site-search">
        <span>Filter catalog</span>
        <input
          v-model="query"
          type="search"
          placeholder="twitter, office, blender, finance..."
          autocomplete="off"
        />
      </label>
    </div>

    <div class="site-filter" aria-label="Filter by surface">
      <button
        type="button"
        :class="{ active: selectedType === 'all' }"
        @click="selectedType = 'all'"
      >
        All <span>{{ adapters.length }}</span>
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
      Showing {{ filteredAdapters.length }} sites.
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
            <dt>commands</dt>
            <dd>{{ adapter.command_count }}</dd>
          </div>
          <div>
            <dt>auth</dt>
            <dd>
              {{ adapter.auth ? (adapter.strategy ?? "required") : "none" }}
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
