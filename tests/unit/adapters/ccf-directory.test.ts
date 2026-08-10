import { describe, expect, it } from "vitest";

import {
  findCcfConferenceInText,
  findCcfConferences,
  mapCcfConference,
  resolveCcfConference,
  scoreCcfConference,
} from "../../../src/adapters/ccf/directory.js";
import { CCF_A_CONFERENCES } from "../../../src/adapters/ccf/directory-data.js";
import {
  ccfCrossrefContainerQuery,
  ccfResidualSearchQuery,
} from "../../../src/adapters/ccf/resolve.js";

describe("CCF seventh-edition A-class conference directory", () => {
  it("ships all 58 official A-class conferences with unique identities", () => {
    expect(CCF_A_CONFERENCES).toHaveLength(58);
    expect(new Set(CCF_A_CONFERENCES.map((row) => row.acronym)).size).toBe(58);
    expect(findCcfConferences({})).toHaveLength(58);
    expect(
      CCF_A_CONFERENCES.every(
        (row) =>
          row.edition === 7 &&
          row.directory_year === 2026 &&
          row.updated === "2026-04-09" &&
          row.rank === "A",
      ),
    ).toBe(true);
  });

  it("resolves exact identities and embedded publisher-specific acronyms", () => {
    expect(resolveCcfConference("ASPLOS", "ACM")?.acronym).toBe("ASPLOS");
    expect(resolveCcfConference("MICRO", "IEEE")?.acronym).toBe("MICRO");
    expect(resolveCcfConference("Management of Data", "ACM")?.acronym).toBe(
      "SIGMOD",
    );
    const web = resolveCcfConference("ACM Web Conference", "ACM");
    expect(web?.acronym).toBe("WWW");
    expect(ccfCrossrefContainerQuery(web!)).toBe("ACM Web Conference");
    const ppopp = resolveCcfConference("PPoPP", "ACM");
    expect(ccfCrossrefContainerQuery(ppopp!)).toBe(ppopp?.name);
    expect(
      findCcfConferenceInText("find CVPR 2025 papers", "IEEE")?.acronym,
    ).toBe("CVPR");
    expect(findCcfConferenceInText("scalable graph algorithms", "IEEE")).toBe(
      undefined,
    );
  });

  it("reflects seventh-edition additions, removal, and conference rename", () => {
    const ai = findCcfConferences({ category: "人工智能" });
    expect(ai).toHaveLength(7);
    expect(ai.map((row) => row.venue)).toContain("ICLR");
    expect(ai.map((row) => row.venue)).not.toContain("IJCAI");

    expect(findCcfConferences({ query: "USENIX ATC" })).toEqual([
      expect.objectContaining({
        venue: "ACM SIGOPS ATC",
        rank: "A",
        aliases: ["USENIX ATC", "ATC"],
      }),
    ]);
    expect(findCcfConferences({ query: "HPDC" })[0]).toMatchObject({
      venue: "HPDC",
      rank: "A",
    });
  });

  it("resolves punctuation, former acronyms, and publication-style aliases", () => {
    for (const [query, expected] of [
      ["IEEE S&P", "S&P"],
      ["NIPS", "NeurIPS"],
      ["PVLDB", "VLDB"],
      ["IMWUT", "UbiComp"],
      ["IEEE VIS", "IEEE VIS"],
      ["ACMMM", "ACM MM"],
    ]) {
      expect(findCcfConferences({ query })[0]?.venue).toBe(expected);
    }
  });

  it("separates conference identity and source context from topical terms", () => {
    const sp = CCF_A_CONFERENCES.find((row) => row.acronym === "S&P")!;
    const cav = CCF_A_CONFERENCES.find((row) => row.acronym === "CAV")!;
    expect(ccfResidualSearchQuery("IEEE S&P 2024 Oakland papers", sp)).toBe(
      undefined,
    );
    expect(
      ccfResidualSearchQuery(
        "CAV 2024 Computer Aided Verification Springer LNCS",
        cav,
      ),
    ).toBeUndefined();
    expect(ccfResidualSearchQuery("CAV 2024 neural invariants", cav)).toBe(
      "neural invariants",
    );
  });

  it("keeps the formal PDF source and page on normalized rows", () => {
    const iclr = CCF_A_CONFERENCES.find((row) => row.acronym === "ICLR")!;
    expect(scoreCcfConference(iclr, "ICLR")).toBe(100);
    expect(mapCcfConference(iclr)).toMatchObject({
      relation: "official-conference",
      venue: "ICLR",
      rank: "A",
      edition: 7,
      directory_year: 2026,
      directory_updated: "2026-04-09",
      pdf_page: 57,
      source_adapter: "ccf",
    });
  });
});
