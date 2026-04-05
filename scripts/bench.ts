/**
 * Performance benchmarks for Uni-CLI.
 * Measures startup, adapter loading, and command resolution times.
 *
 * Usage: npx tsx scripts/bench.ts
 * Output: JSON to stdout (suitable for CI tracking)
 */

async function bench() {
  const results: Record<string, number | boolean> = {};

  // 1. Startup time — measure CLI module import
  const startImport = performance.now();
  const { loadAllAdapters } = await import("../src/discovery/loader.js");
  results.import_ms = Math.round((performance.now() - startImport) * 100) / 100;

  // 2. Adapter loading time (YAML adapters from built-in + user dirs)
  const startLoad = performance.now();
  const count = loadAllAdapters();
  results.adapter_load_ms =
    Math.round((performance.now() - startLoad) * 100) / 100;
  results.adapter_count = count;

  // 3. Command resolution time
  const { resolveCommand, getAllAdapters } = await import("../src/registry.js");
  const startResolve = performance.now();
  // Resolve a known built-in adapter (hackernews/top)
  const resolved = resolveCommand("hackernews", "top");
  results.resolve_ms =
    Math.round((performance.now() - startResolve) * 100) / 100;
  results.resolve_found = resolved !== undefined;

  // 4. Total adapters and commands
  const adapters = getAllAdapters();
  let totalCommands = 0;
  for (const adapter of adapters) {
    totalCommands += Object.keys(adapter.commands).length;
  }
  results.total_sites = adapters.length;
  results.total_commands = totalCommands;

  console.log(JSON.stringify(results, null, 2));
}

bench().catch((err) => {
  console.error(err);
  process.exit(1);
});
