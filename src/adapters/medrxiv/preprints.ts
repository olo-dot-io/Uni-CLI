/**
 * @owner       src::adapters::medrxiv::preprints
 * @does        Registers medRxiv recent/search, DOI metadata, PDF download, and read commands backed by the official xRxiv API helpers.
 * @needs       src/adapters/rxiv/preprints.ts, api.biorxiv.org medRxiv endpoints, medRxiv PDF/JATS asset URLs.
 * @feeds       surface coverage ledger, clinical preprint discovery/search, scholar DOI read/download routing.
 * @breaks      medRxiv API drift, date-window search exhaustion, source-asset denial, or missing pdftotext stops read/download rather than fabricating text.
 */

import { cli, Strategy } from "../../registry.js";
import {
  downloadRxivPdf,
  fetchPaperRow,
  fetchRecentRows,
  fetchSearchRows,
  readRxivPaper,
  RXIV_DOWNLOAD_ARGS,
  RXIV_DOWNLOAD_CAPABILITIES,
  RXIV_DOWNLOAD_COLUMNS,
  RXIV_PAPER_ARGS,
  RXIV_PAPER_CAPABILITIES,
  RXIV_PAPER_COLUMNS,
  RXIV_READ_ARGS,
  RXIV_READ_CAPABILITIES,
  RXIV_READ_COLUMNS,
  RXIV_RECENT_ARGS,
  RXIV_RECENT_CAPABILITIES,
  RXIV_RECENT_COLUMNS,
  RXIV_SEARCH_ARGS,
  RXIV_SEARCH_CAPABILITIES,
  RXIV_SEARCH_COLUMNS,
  type RxivConfig,
} from "../rxiv/preprints.js";

const CONFIG: RxivConfig = {
  site: "medrxiv",
  label: "medRxiv",
  apiServer: "medrxiv",
  webOrigin: "https://www.medrxiv.org",
};
const DOMAIN = "api.biorxiv.org";

cli({
  site: "medrxiv",
  name: "recent",
  description: "List recent medRxiv preprints from the official API",
  domain: DOMAIN,
  strategy: Strategy.PUBLIC,
  args: RXIV_RECENT_ARGS,
  columns: RXIV_RECENT_COLUMNS,
  capabilities: RXIV_RECENT_CAPABILITIES,
  func: async (_page, kwargs) => fetchRecentRows(CONFIG, kwargs),
});

cli({
  site: "medrxiv",
  name: "search",
  description:
    "Search medRxiv official API metadata within a bounded date window",
  domain: DOMAIN,
  strategy: Strategy.PUBLIC,
  args: RXIV_SEARCH_ARGS,
  columns: RXIV_SEARCH_COLUMNS,
  capabilities: RXIV_SEARCH_CAPABILITIES,
  func: async (_page, kwargs) => fetchSearchRows(CONFIG, kwargs),
});

cli({
  site: "medrxiv",
  name: "paper",
  description: "Fetch medRxiv preprint metadata by DOI",
  domain: DOMAIN,
  strategy: Strategy.PUBLIC,
  args: RXIV_PAPER_ARGS,
  columns: RXIV_PAPER_COLUMNS,
  capabilities: RXIV_PAPER_CAPABILITIES,
  func: async (_page, kwargs) => [
    await fetchPaperRow(CONFIG, kwargs.doi ?? kwargs.id ?? kwargs.ref),
  ],
});

cli({
  site: "medrxiv",
  name: "download",
  description: "Download a medRxiv preprint PDF by DOI",
  domain: DOMAIN,
  strategy: Strategy.PUBLIC,
  args: RXIV_DOWNLOAD_ARGS,
  columns: RXIV_DOWNLOAD_COLUMNS,
  capabilities: RXIV_DOWNLOAD_CAPABILITIES,
  minimum_capability: "http.download",
  func: async (_page, kwargs) => [
    await downloadRxivPdf(
      CONFIG,
      await fetchPaperRow(CONFIG, kwargs.doi ?? kwargs.id ?? kwargs.ref),
      kwargs.output,
    ),
  ],
});

cli({
  site: "medrxiv",
  name: "read",
  description:
    "Read medRxiv preprint text by DOI, preferring JATS XML before PDF extraction",
  domain: DOMAIN,
  strategy: Strategy.PUBLIC,
  args: RXIV_READ_ARGS,
  columns: RXIV_READ_COLUMNS,
  capabilities: RXIV_READ_CAPABILITIES,
  minimum_capability: "subprocess.exec",
  func: async (_page, kwargs) => [await readRxivPaper(CONFIG, kwargs)],
});
