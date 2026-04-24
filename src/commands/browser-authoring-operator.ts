import { Command } from "commander";
import { analyzeSite, type PageSignals } from "../browser/analyze.js";
import {
  DEFAULT_NETWORK_CACHE_TTL_MS,
  bodyMatchesNetworkFilter,
  findNetworkCacheEntry,
  loadNetworkCache,
  parseNetworkFilter,
  saveNetworkCache,
  toCachedNetworkEntries,
  truncateNetworkBody,
} from "../browser/network-cache.js";
import { getAllAdapters } from "../registry.js";
import {
  ensureNetworkCapture,
  getOperatorPage,
  operatorAction,
  readNetworkEntries,
  resolveWorkspace,
} from "./browser-operator-runtime.js";

function commandError(
  code: string,
  message: string,
  suggestion?: string,
): Error & { code: string; suggestion?: string } {
  const err = new Error(message) as Error & {
    code: string;
    suggestion?: string;
  };
  err.code = code;
  if (suggestion) err.suggestion = suggestion;
  return err;
}

function bodyPreview(body: unknown): string | null {
  if (body === undefined) return null;
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return raw.slice(0, 2000);
}

export function registerBrowserAuthoringSubcommands(
  root: Command,
  program: Command,
  namespace: "browser" | "operate",
): void {
  root
    .command("analyze <url>")
    .description("Classify a site for adapter authoring")
    .action((url: string) =>
      operatorAction(program, root, namespace, "analyze", async () => {
        const page = await getOperatorPage(root, namespace);
        await ensureNetworkCapture(page);
        await page.goto(url, { settleMs: 2000 });
        await page.wait(2);
        const { normalized } = await readNetworkEntries(page);
        const cookieNames = (await page.evaluate(
          "(document.cookie || '').split(';').map((c) => c.trim().split('=')[0]).filter(Boolean)",
        )) as string[];
        const initialState = (await page.evaluate(
          `({
            __INITIAL_STATE__: !!window.__INITIAL_STATE__,
            __NUXT__: !!window.__NUXT__,
            __NEXT_DATA__: !!window.__NEXT_DATA__,
            __APOLLO_STATE__: !!window.__APOLLO_STATE__
          })`,
        )) as PageSignals["initialState"];
        const signals: PageSignals = {
          requestedUrl: url,
          finalUrl: await page.url(),
          title: await page.title(),
          cookieNames,
          initialState,
          networkEntries: normalized.map((entry) => ({
            url: entry.url,
            status: entry.status,
            contentType: entry.contentType,
            bodyPreview: bodyPreview(entry.body),
          })),
        };
        return analyzeSite(signals, getAllAdapters());
      }),
    );

  root
    .command("network [pattern]")
    .description("Show captured network requests")
    .option("--all", "show all requests (no filter)")
    .option("--raw", "include response bodies when available")
    .option("--detail <key>", "read full body for a cached network entry")
    .option(
      "--filter <fields>",
      "comma-separated body field names; keep entries containing all fields",
    )
    .option(
      "--max-body <chars>",
      "with --detail, cap emitted body chars (0 = unlimited)",
      "0",
    )
    .option(
      "--ttl <ms>",
      "cache TTL for --detail",
      String(DEFAULT_NETWORK_CACHE_TTL_MS),
    )
    .action(
      (
        pattern: string | undefined,
        opts: {
          all?: boolean;
          raw?: boolean;
          detail?: string;
          filter?: string;
          maxBody: string;
          ttl: string;
        },
      ) =>
        operatorAction(program, root, namespace, "network", async () => {
          const workspace = resolveWorkspace(root, namespace);
          if (opts.detail) {
            if (opts.filter) {
              throw commandError(
                "invalid_input",
                "--filter and --detail cannot be used together",
              );
            }
            const loaded = loadNetworkCache(workspace, {
              ttlMs: parseInt(opts.ttl, 10) || DEFAULT_NETWORK_CACHE_TTL_MS,
            });
            if (loaded.status === "missing") {
              throw commandError(
                "not_found",
                `No network cache for workspace "${workspace}"`,
                "Run `unicli browser network` first.",
              );
            }
            if (loaded.status === "corrupt") {
              throw commandError(
                "internal_error",
                "Network cache file is malformed",
                "Re-run `unicli browser network` to regenerate it.",
              );
            }
            if (loaded.status === "expired") {
              throw commandError(
                "stale_ref",
                `Network cache expired after ${String(loaded.ageMs)}ms`,
                "Re-run `unicli browser network` to refresh it.",
              );
            }
            if (loaded.status !== "ok") {
              throw commandError(
                "internal_error",
                "Unexpected network cache state",
              );
            }
            const entry = findNetworkCacheEntry(loaded.file, opts.detail);
            if (!entry) {
              throw commandError(
                "not_found",
                `Network cache entry not found: ${opts.detail}`,
              );
            }
            return truncateNetworkBody(entry, parseInt(opts.maxBody, 10) || 0);
          }

          let filterFields: string[] | null = null;
          if (opts.filter) {
            const parsed = parseNetworkFilter(opts.filter);
            if (!parsed.ok) {
              throw commandError("invalid_input", parsed.reason);
            }
            filterFields = parsed.fields;
          }

          const page = await getOperatorPage(root, namespace);
          const { normalized } = await readNetworkEntries(page);
          const cached = toCachedNetworkEntries(normalized);
          saveNetworkCache(workspace, cached);

          const filtered =
            pattern && !opts.all
              ? cached.filter((entry) => entry.url.includes(pattern))
              : cached;
          const visible = filterFields
            ? filtered.filter((entry) =>
                bodyMatchesNetworkFilter(entry.body, filterFields),
              )
            : filtered;
          if (!opts.raw) {
            return visible.map(({ body: _body, ...entry }) => entry);
          }

          return visible;
        }),
    );
}
