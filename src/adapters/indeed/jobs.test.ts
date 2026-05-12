import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  INDEED_JOB_COLUMNS,
  INDEED_SEARCH_COLUMNS,
  buildIndeedJobUrl,
  buildIndeedSearchExtractScript,
  buildIndeedSearchUrl,
  coerceIndeedInt,
  dedupeIndeedTags,
  indeedSearchCardToRow,
  requireIndeedBoundedInt,
  requireIndeedFromage,
  requireIndeedJobKey,
  requireIndeedNonNegativeInt,
  requireIndeedQuery,
  requireIndeedSort,
} from "./jobs.js";

function pageMock(evaluateResult: unknown) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
  };
}

describe("indeed agent-facing commands", () => {
  it("registers search and job commands with stable columns", () => {
    const search = resolveCommand("indeed", "search")?.command;
    const job = resolveCommand("indeed", "job")?.command;
    expect(search?.browser).toBe(true);
    expect(search?.strategy).toBe("cookie");
    expect(search?.columns).toEqual(INDEED_SEARCH_COLUMNS);
    expect(job?.browser).toBe(true);
    expect(job?.strategy).toBe("cookie");
    expect(job?.columns).toEqual(INDEED_JOB_COLUMNS);
  });

  it("validates arguments before browser work", async () => {
    expect(coerceIndeedInt("5")).toBe(5);
    expect(coerceIndeedInt("1.5")).toBeNaN();
    expect(requireIndeedBoundedInt("15", 15, 25, "limit")).toBe(15);
    expect(() => requireIndeedBoundedInt(30, 15, 25, "limit")).toThrow("<= 25");
    expect(requireIndeedNonNegativeInt(0, 0, "start")).toBe(0);
    expect(() => requireIndeedNonNegativeInt(-1, 0, "start")).toThrow(
      "non-negative",
    );
    expect(requireIndeedJobKey("DCCC07AC5A6A3683")).toBe("dccc07ac5a6a3683");
    expect(() => requireIndeedJobKey("not-hex")).toThrow("valid jk");
    expect(requireIndeedQuery(" rust ")).toBe("rust");
    expect(() => requireIndeedQuery(" ")).toThrow("cannot be empty");
    expect(requireIndeedFromage("7")).toBe("7");
    expect(() => requireIndeedFromage("30")).toThrow("1/3/7/14");
    expect(requireIndeedSort("DATE")).toBe("date");
    expect(() => requireIndeedSort("newest")).toThrow("relevance");
    const search = resolveCommand("indeed", "search")?.command;
    const page = pageMock({ cards: [], challenge: false, ready: true });
    await expect(
      search!.func!(page, { query: "rust", limit: 0 }),
    ).rejects.toThrow("positive integer");
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("builds URLs and normalizes search cards", () => {
    expect(
      buildIndeedSearchUrl({
        query: "software engineer",
        location: "",
        fromage: "",
        sort: "relevance",
        start: 0,
      }),
    ).toBe("https://www.indeed.com/jobs?q=software+engineer");
    expect(
      buildIndeedSearchUrl({
        query: "rust",
        location: "remote",
        fromage: "7",
        sort: "date",
        start: 20,
      }),
    ).toBe(
      "https://www.indeed.com/jobs?q=rust&l=remote&fromage=7&sort=date&start=20",
    );
    expect(buildIndeedJobUrl("dccc07ac5a6a3683")).toBe(
      "https://www.indeed.com/viewjob?jk=dccc07ac5a6a3683",
    );
    expect(
      dedupeIndeedTags(
        ["$180,000 a year", "Full-time", "401(k)", "Full-time"],
        "$180,000 a year",
      ),
    ).toBe("Full-time · 401(k)");
    expect(
      indeedSearchCardToRow(
        {
          jk: "dccc07ac5a6a3683",
          title: " Senior  Rust Engineer ",
          company: "Acme",
          location: "Remote",
          salary: "$180,000 a year",
          tags: ["$180,000 a year", "Full-time", "401(k)"],
        },
        11,
      ),
    ).toEqual({
      rank: 11,
      id: "dccc07ac5a6a3683",
      title: "Senior Rust Engineer",
      company: "Acme",
      location: "Remote",
      salary: "$180,000 a year",
      tags: "Full-time · 401(k)",
      url: "https://www.indeed.com/viewjob?jk=dccc07ac5a6a3683",
    });
  });

  it("search maps challenge, timeout, empty, and success states explicitly", async () => {
    const search = resolveCommand("indeed", "search")?.command;
    await expect(
      search!.func!(pageMock({ cards: [], challenge: true, ready: true }), {
        query: "rust engineer",
      }),
    ).rejects.toThrow("Cloudflare");
    await expect(
      search!.func!(pageMock({ cards: [], challenge: false, ready: false }), {
        query: "rust engineer",
      }),
    ).rejects.toThrow("did not expose result");
    await expect(
      search!.func!(pageMock({ cards: [], challenge: false, ready: true }), {
        query: "zzzxxyyqqnonexistent",
        location: "Remote",
      }),
    ).rejects.toThrow("No Indeed jobs matched");
    const page = pageMock({
      cards: [
        {
          jk: "dccc07ac5a6a3683",
          title: " Senior  Rust Engineer ",
          company: "Acme",
          location: "Remote",
          salary: "$180,000 a year",
          tags: ["$180,000 a year", "Full-time"],
        },
      ],
      challenge: false,
      ready: true,
    });
    await expect(
      search!.func!(page, {
        query: "rust engineer",
        location: "Remote",
        fromage: "7",
        sort: "date",
        start: 10,
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        rank: 11,
        id: "dccc07ac5a6a3683",
        title: "Senior Rust Engineer",
      }),
    ]);
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.indeed.com/jobs?q=rust+engineer&l=Remote&fromage=7&sort=date&start=10",
    );
  });

  it("job maps invalid id, challenge, timeout, missing, and success states explicitly", async () => {
    const job = resolveCommand("indeed", "job")?.command;
    const invalidPage = pageMock({ ready: true });
    await expect(job!.func!(invalidPage, { id: "not-hex" })).rejects.toThrow(
      "valid jk",
    );
    expect(invalidPage.goto).not.toHaveBeenCalled();
    await expect(
      job!.func!(pageMock({ ready: true, challenge: true, notFound: false }), {
        id: "dccc07ac5a6a3683",
      }),
    ).rejects.toThrow("Cloudflare");
    await expect(
      job!.func!(
        pageMock({ ready: false, challenge: false, notFound: false }),
        { id: "dccc07ac5a6a3683" },
      ),
    ).rejects.toThrow("did not expose detail");
    await expect(
      job!.func!(pageMock({ ready: true, challenge: false, notFound: true }), {
        id: "dccc07ac5a6a3683",
      }),
    ).rejects.toThrow("No Indeed job posting");
    await expect(
      job!.func!(
        pageMock({
          ready: true,
          challenge: false,
          notFound: false,
          title: " Senior Rust Engineer ",
          company: "Acme",
          location: "Remote",
          salary: "$180,000 a year",
          jobType: "Full-time",
          description: "Build systems",
        }),
        { id: "DCCC07AC5A6A3683" },
      ),
    ).resolves.toEqual([
      {
        id: "dccc07ac5a6a3683",
        title: "Senior Rust Engineer",
        company: "Acme",
        location: "Remote",
        salary: "$180,000 a year",
        job_type: "Full-time",
        description: "Build systems",
        url: "https://www.indeed.com/viewjob?jk=dccc07ac5a6a3683",
      },
    ]);
  });

  it("search extraction script distinguishes result cards and challenge pages", () => {
    const script = buildIndeedSearchExtractScript();
    expect(script).toContain(".job_seen_beacon");
    expect(script).toContain("Just a moment");
    expect(script).toContain("did not match any jobs");
  });
});
