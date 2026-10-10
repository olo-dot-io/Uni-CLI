import { performance } from "node:perf_hooks";
import { readManifest } from "../src/fast-path/manifest.js";
import { manifestSearchDocuments } from "../src/fast-path/handlers/discovery.js";
import { loadAllAdapters, loadTsAdapters } from "../src/discovery/loader.js";
import {
  invalidateCache,
  runtimeSearchDocuments,
  search,
  searchDocuments,
} from "../src/discovery/search.js";
import {
  discoverMacosDynamicData,
  invalidateMacosDynamicCache,
  registerMacosDynamicCommands,
} from "../src/discovery/macos-dynamic.js";

const queries = [
  "agent search computer use recent memes and discussion",
  "web search official documentation",
  "arxiv search papers",
  "下载B站视频",
  "twiter search",
  "capture desktop accessibility context",
  "我的收藏",
  "hacker news top stories",
];

function measure(run: (query: string) => unknown, repetitions = 40) {
  const samples: number[] = [];
  for (const query of queries) run(query);
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const query of queries) {
      const started = performance.now();
      run(query);
      samples.push(performance.now() - started);
    }
  }
  samples.sort((a, b) => a - b);
  return {
    queries: samples.length,
    median_ms: samples[Math.floor(samples.length * 0.5)],
    p95_ms: samples[Math.floor(samples.length * 0.95)],
  };
}

process.env.UNICLI_DYNAMIC_MACOS = "0";
const documents = manifestSearchDocuments(readManifest());
const manifestSearch = measure((query) => searchDocuments(documents, query, 8));
loadAllAdapters();
await loadTsAdapters();
const staticResidentSearch = measure((query) => search(query, 8));

process.env.UNICLI_DYNAMIC_MACOS = "1";
invalidateCache();
const discoveryStarted = performance.now();
const inventory = discoverMacosDynamicData();
const discoveryMs = performance.now() - discoveryStarted;
registerMacosDynamicCommands();
const dynamicResidentSearch = measure((query) => search(query, 8));
const beforeRefresh = search("macos app actions", 8);
invalidateMacosDynamicCache();
const afterRefresh = search("macos app actions", 8);

console.log(
  JSON.stringify(
    {
      catalog_documents: documents.length,
      dynamic_runtime_documents: runtimeSearchDocuments().length,
      dynamic_shortcuts: inventory.shortcuts.length,
      dynamic_app_actions: inventory.appActions.length,
      dynamic_inventory_ms: discoveryMs,
      manifest_search: manifestSearch,
      static_resident_search: staticResidentSearch,
      dynamic_resident_search: dynamicResidentSearch,
      stable_inventory_refresh:
        JSON.stringify(beforeRefresh) === JSON.stringify(afterRefresh),
    },
    null,
    2,
  ),
);
