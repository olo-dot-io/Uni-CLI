import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

function isScholarUserId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,20}$/.test(value) && !/\s/.test(value);
}

cli({
  site: "google-scholar",
  name: "profile",
  description: "Read a Google Scholar author profile and top papers",
  domain: "scholar.google.com",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: "author", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 10 },
  ],
  columns: ["rank", "kind", "title", "authors", "year", "cited", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const author = str(kwargs.author).trim();
    const limit = intArg(kwargs.limit, 10, 100);

    if (isScholarUserId(author)) {
      await p.goto(
        `https://scholar.google.com/citations?user=${encodeURIComponent(author)}&hl=en`,
        { settleMs: 2500 },
      );
    } else {
      await p.goto(
        `https://scholar.google.com/citations?view_op=search_authors&mauthors=${encodeURIComponent(author)}&hl=en`,
        { settleMs: 2500 },
      );
      const profileUrl = str(
        await p.evaluate(`(() => {
          const link = document.querySelector('.gsc_1usr_name a, a[href*="citations?user="]');
          return link ? new URL(link.getAttribute('href') || '', location.href).href : '';
        })()`),
      );
      if (!profileUrl) {
        return [
          {
            rank: 0,
            kind: "profile",
            title: author,
            cited: "profile_not_found",
            url: "",
          },
        ];
      }
      await p.goto(profileUrl, { settleMs: 2500 });
    }

    const rows = await p.evaluate(`(() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const metric = (label) => {
        const rows = [...document.querySelectorAll('#gsc_rsb_st tr')];
        const row = rows.find((item) => normalize(item.children?.[0]?.textContent).toLowerCase() === label.toLowerCase());
        return normalize(row?.children?.[1]?.textContent);
      };
      const name = normalize(document.querySelector('#gsc_prf_in')?.textContent);
      const affiliation = normalize(document.querySelector('.gsc_prf_il')?.textContent);
      const output = [{
        rank: 0,
        kind: 'profile',
        title: affiliation ? name + ' (' + affiliation + ')' : name,
        authors: '',
        year: '',
        cited: 'h=' + metric('h-index') + ' i10=' + metric('i10-index') + ' total=' + metric('Citations'),
        url: location.href,
      }];
      const papers = [...document.querySelectorAll('#gsc_a_b .gsc_a_tr')];
      for (const paper of papers.slice(0, ${js(limit)})) {
        const titleLink = paper.querySelector('.gsc_a_at');
        output.push({
          rank: output.length,
          kind: 'paper',
          title: normalize(titleLink?.textContent),
          authors: normalize(paper.querySelector('.gs_gray')?.textContent),
          year: normalize(paper.querySelector('.gsc_a_y')?.textContent),
          cited: normalize(paper.querySelector('.gsc_a_c')?.textContent) || '0',
          url: titleLink ? new URL(titleLink.getAttribute('href') || '', location.href).href : '',
        });
      }
      return output;
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
