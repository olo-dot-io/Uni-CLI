/** Xiaohongshu Creator Note Detail command registration. */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { fetchCreatorNoteDetailRows } from "./_creator-note-detail-data.js";

export type { CreatorNoteDetailRow } from "./_creator-note-detail-data.js";

cli({
  site: "xiaohongshu",
  name: "creator-note-detail",
  description:
    "Xiaohongshu single note detail page data (core metrics + audience + trends)",
  domain: "creator.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "note-id",
      positional: true,
      required: true,
      description: "Note ID (from creator-notes or note-detail page URL)",
    },
  ],
  columns: ["section", "metric", "value", "extra"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const noteId: string = String(kwargs["note-id"]);
    const rows = await fetchCreatorNoteDetailRows(p, noteId);

    const hasCoreMetric = rows.some(
      (row) => row.section !== "note_info" && row.value,
    );
    if (!hasCoreMetric) {
      throw new Error(
        "No note detail data found. Check note_id and login status for creator.xiaohongshu.com.",
      );
    }

    return rows;
  },
});
