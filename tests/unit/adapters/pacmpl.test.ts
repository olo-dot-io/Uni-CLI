/**
 * Owned PACMPL issue mapping and conference selection tests. Fixtures use
 * reduced Crossref response fields and do not execute external requests.
 */

import { describe, expect, it } from "vitest";

import {
  mapPacmplItem,
  matchesPacmplSelection,
  mergePacmplIssueRows,
  pacmplIssuesForYear,
  rankPacmplRows,
  resolvePacmplVenue,
  type PacmplCrossrefItem,
  type PacmplIssue,
  type PacmplWorkRecord,
} from "../../../src/adapters/pacmpl/works.js";

function fixture(
  doi: string,
  title: string,
  issue: PacmplIssue,
  options: { year?: number; link?: PacmplCrossrefItem["link"] } = {},
): PacmplCrossrefItem {
  return {
    DOI: doi,
    title: [title],
    author: [{ given: "Ada", family: "Lovelace" }],
    "container-title": ["Proceedings of the ACM on Programming Languages"],
    ISSN: ["2475-1421"],
    issued: { "date-parts": [[options.year ?? 2024, 4, 29]] },
    volume: "8",
    issue,
    type: "journal-article",
    URL: `https://doi.org/${doi}`,
    link: options.link,
  };
}

function row(doi: string, title: string, issue: PacmplIssue): PacmplWorkRecord {
  return mapPacmplItem(fixture(doi, title, issue));
}

describe("PACMPL conference issue model", () => {
  it("resolves OOPSLA as legacy and split issues while retaining explicit parts", () => {
    expect(resolvePacmplVenue("OOPSLA")).toEqual({
      conference: "OOPSLA",
      issues: ["OOPSLA", "OOPSLA1", "OOPSLA2"],
    });
    expect(resolvePacmplVenue("OOPSLA 1")).toEqual({
      conference: "OOPSLA",
      issues: ["OOPSLA1"],
    });
    expect(resolvePacmplVenue("OOPSLA2")).toEqual({
      conference: "OOPSLA",
      issues: ["OOPSLA2"],
    });
  });

  it("resolves expanded POPL, PLDI, and ICFP names and rejects nearby venues", () => {
    expect(resolvePacmplVenue("Principles of Programming Languages")).toEqual({
      conference: "POPL",
      issues: ["POPL"],
    });
    expect(
      resolvePacmplVenue("Programming Language Design and Implementation"),
    ).toEqual({ conference: "PLDI", issues: ["PLDI"] });
    expect(
      resolvePacmplVenue("International Conference on Functional Programming"),
    ).toEqual({ conference: "ICFP", issues: ["ICFP"] });
    expect(() => resolvePacmplVenue("MPLR")).toThrow("not supported");
  });

  it("maps PACMPL issue and volume into a conference-facing work record", () => {
    expect(
      mapPacmplItem(
        fixture("10.1145/3649826", "AdoB", "OOPSLA1", {
          link: [
            {
              URL: "https://dl.acm.org/doi/10.1145/3649826",
              "content-type": "unspecified",
            },
            {
              URL: "https://dl.acm.org/doi/pdf/10.1145/3649826",
              "content-type": "unspecified",
            },
          ],
        }),
      ),
    ).toMatchObject({
      id: "10.1145/3649826",
      title: "AdoB",
      authors: ["Ada Lovelace"],
      year: 2024,
      venue: "OOPSLA 2024",
      conference: "OOPSLA",
      issue: "OOPSLA1",
      volume: "8",
      doi: "10.1145/3649826",
      pdf_url: "https://dl.acm.org/doi/pdf/10.1145/3649826",
      source_adapter: "pacmpl",
      raw: {
        container_title: "Proceedings of the ACM on Programming Languages",
        issue: "OOPSLA1",
        volume: "8",
        pacmpl_conference: "OOPSLA",
      },
    });
  });

  it("does not construct a PDF URL when Crossref supplies only a landing link", () => {
    const mapped = mapPacmplItem(
      fixture("10.1145/3701234", "No Declared PDF", "POPL", {
        link: [
          {
            URL: "https://dl.acm.org/doi/10.1145/3701234",
            "content-type": "text/html",
          },
        ],
      }),
    );
    expect(mapped.pdf_url).toBeUndefined();
    expect(mapped.source_url).toBe("https://doi.org/10.1145/3701234");
  });

  it("rejects ACM records outside recognised PACMPL issues", () => {
    expect(() =>
      mapPacmplItem({
        ...fixture("10.1145/3705678", "An MPLR Paper", "PLDI"),
        issue: "MPLR",
      }),
    ).toThrow("not a supported PACMPL conference issue");
    expect(() =>
      mapPacmplItem({
        ...fixture("10.1145/3705679", "A Proceedings Paper", "PLDI"),
        "container-title": ["Proceedings of the ACM SIGPLAN Conference"],
        ISSN: [],
      }),
    ).toThrow("not a supported PACMPL conference issue");
  });

  it("matches OOPSLA legacy and split issues with a hard publication year", () => {
    const selection = resolvePacmplVenue("OOPSLA");
    expect(
      matchesPacmplSelection(
        row("10.1145/1", "Legacy", "OOPSLA"),
        selection,
        2024,
      ),
    ).toBe(true);
    expect(
      matchesPacmplSelection(
        row("10.1145/2", "Part Two", "OOPSLA2"),
        selection,
        2024,
      ),
    ).toBe(true);
    expect(
      matchesPacmplSelection(
        row("10.1145/3", "A POPL Paper", "POPL"),
        selection,
        2024,
      ),
    ).toBe(false);
    expect(
      matchesPacmplSelection(
        mapPacmplItem(
          fixture("10.1145/4", "An Old OOPSLA Paper", "OOPSLA1", {
            year: 2023,
          }),
        ),
        selection,
        2024,
      ),
    ).toBe(false);
  });

  it("queries the legacy OOPSLA issue before the metadata split and both parts after it", () => {
    const selection = resolvePacmplVenue("OOPSLA");
    expect(pacmplIssuesForYear(selection, 2021)).toEqual(["OOPSLA"]);
    expect(pacmplIssuesForYear(selection, 2022)).toEqual([
      "OOPSLA1",
      "OOPSLA2",
    ]);
    expect(pacmplIssuesForYear(selection, undefined)).toEqual([
      "OOPSLA",
      "OOPSLA1",
      "OOPSLA2",
    ]);
    expect(pacmplIssuesForYear(resolvePacmplVenue("OOPSLA1"), 2021)).toEqual([
      "OOPSLA1",
    ]);
  });

  it("round-robins OOPSLA issue groups so a bounded result contains both parts", () => {
    const merged = mergePacmplIssueRows(
      [
        [
          row("10.1145/11", "Part One A", "OOPSLA1"),
          row("10.1145/12", "Part One B", "OOPSLA1"),
        ],
        [
          row("10.1145/21", "Part Two A", "OOPSLA2"),
          row("10.1145/22", "Part Two B", "OOPSLA2"),
        ],
      ],
      3,
    );
    expect(merged.map((record) => record.issue)).toEqual([
      "OOPSLA1",
      "OOPSLA2",
      "OOPSLA1",
    ]);
  });

  it("ranks an exact title from OOPSLA2 ahead of unrelated OOPSLA1 rows", () => {
    const target = row(
      "10.1145/31",
      "Contextual Dispatch for Robust Programs",
      "OOPSLA2",
    );
    const ranked = rankPacmplRows(
      [row("10.1145/32", "Unrelated Static Analysis", "OOPSLA1"), target],
      "Contextual Dispatch for Robust Programs",
      2,
    );
    expect(ranked[0]).toBe(target);
  });
});
