import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str, visibleText } from "../_shared/browser-tools.js";

const STYLE_LABELS: Record<string, string> = {
  bibtex: "BibTeX",
  endnote: "EndNote",
  refman: "RefMan",
  refworks: "RefWorks",
};

cli({
  site: "google-scholar",
  name: "cite",
  description: "Fetch a Google Scholar citation for a paper",
  domain: "scholar.google.com",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    {
      name: "style",
      type: "str",
      default: "bibtex",
      choices: Object.keys(STYLE_LABELS),
    },
    { name: "index", type: "int", default: 1 },
  ],
  columns: ["title", "format", "citation"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const query = str(kwargs.query).trim();
    const style = str(kwargs.style, "bibtex").toLowerCase();
    const label = STYLE_LABELS[style] ?? STYLE_LABELS.bibtex;
    const index = intArg(kwargs.index, 1, 20);

    await p.goto(
      `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&hl=en`,
      { settleMs: 2500 },
    );

    const clickResult = (await p.evaluate(`(() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const cards = [...document.querySelectorAll('.gs_r.gs_or.gs_scl, .gs_r.gs_or')];
      const card = cards[${js(index - 1)}];
      if (!card) return { ok: false, reason: 'result_not_found' };
      const title = normalize(card.querySelector('.gs_rt, h3')?.textContent);
      const button = card.querySelector('a.gs_or_cit, .gs_or_cit');
      if (!(button instanceof HTMLElement)) {
        return { ok: false, title, reason: 'cite_button_not_found' };
      }
      button.click();
      return { ok: true, title };
    })()`)) as { ok?: boolean; title?: string; reason?: string };

    if (!clickResult.ok) {
      return [
        {
          title: clickResult.title ?? query,
          format: style,
          citation: clickResult.reason ?? "citation_unavailable",
        },
      ];
    }

    await p.waitForSelector("#gs_cit", 5000).catch(() => undefined);
    const citationUrl = str(
      await p.evaluate(`(() => {
        const wanted = ${js(label)};
        const links = [...document.querySelectorAll('#gs_citi a, #gs_cit a')];
        const link = links.find((a) => (a.textContent || '').trim().toLowerCase() === wanted.toLowerCase());
        return link ? new URL(link.getAttribute('href') || '', location.href).href : '';
      })()`),
    );

    if (!citationUrl) {
      return [
        {
          title: clickResult.title ?? query,
          format: style,
          citation: "citation_link_not_found",
        },
      ];
    }

    await p.goto(citationUrl, { settleMs: 1200 });
    return [
      {
        title: clickResult.title ?? query,
        format: style,
        citation: await visibleText(p),
      },
    ];
  },
});
