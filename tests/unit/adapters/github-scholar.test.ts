import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGitHubRepositoryQuery,
  canonicalDoi,
  evaluateReadmeEvidence,
  extractDois,
  githubHeaders,
  requireGitHubScholarLimit,
  searchGitHubScholarRepositories,
  significantTitleTerms,
} from "../../../src/adapters/github-scholar/repositories.js";

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function readmeResponse(content: string, repository: string): Response {
  return jsonResponse({
    name: "README.md",
    sha: `${repository}-sha`,
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
    html_url: `https://github.com/${repository}/blob/main/README.md`,
    download_url: `https://raw.githubusercontent.com/${repository}/main/README.md`,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_TOKEN;
});

describe("github scholar evidence rules", () => {
  it("canonicalizes DOI references and extracts exact README DOI values", () => {
    expect(canonicalDoi("https://doi.org/10.1145/3718958.3754348")).toBe(
      "10.1145/3718958.3754348",
    );
    expect(
      extractDois(
        "Paper https://doi.org/10.1145/3718958.3754348, comparison 10.1145/3718958.3754349.",
      ),
    ).toEqual(["10.1145/3718958.3754348", "10.1145/3718958.3754349"]);
    expect(canonicalDoi("paper title")).toBeUndefined();
  });

  it("requires an exact DOI and rejects a neighboring DOI", () => {
    expect(
      evaluateReadmeEvidence(
        "10.1145/3718958.3754348",
        "Citation DOI 10.1145/3718958.3754348.",
      ),
    ).toMatchObject({
      match_type: "doi_exact",
      confidence: 1,
      doi: "10.1145/3718958.3754348",
    });
    expect(
      evaluateReadmeEvidence(
        "10.1145/3718958.3754348",
        "Citation DOI 10.1145/3718958.3754349.",
      ),
    ).toBeUndefined();
  });

  it("accepts exact titles and strict high-overlap title evidence", () => {
    expect(
      evaluateReadmeEvidence(
        "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness",
        "# FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness",
      ),
    ).toMatchObject({ match_type: "title_exact", confidence: 0.98 });

    const overlap = evaluateReadmeEvidence(
      "Efficient Learned Index Structures for Modern Database Systems",
      "This repository implements efficient learned index structures in modern database systems.",
    );
    expect(overlap).toMatchObject({
      match_type: "title_overlap",
      title_overlap: 1,
    });
    expect(overlap?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("rejects generic README vocabulary and underspecified titles", () => {
    expect(
      evaluateReadmeEvidence(
        "Efficient Learned Index Structures for Modern Database Systems",
        "Modern tools for database systems.",
      ),
    ).toBeUndefined();
    expect(
      evaluateReadmeEvidence("Database Systems", "Database Systems"),
    ).toBeUndefined();
    expect(() => buildGitHubRepositoryQuery("Database Systems")).toThrow(
      "too short",
    );
  });

  it("sanitizes repository searches to DOI or significant title terms", () => {
    expect(
      buildGitHubRepositoryQuery("https://doi.org/10.1145/3718958.3754348"),
    ).toBe('"10.1145/3718958.3754348" in:readme');
    expect(
      buildGitHubRepositoryQuery(
        "Efficient Learned Index Structures for Modern Database Systems",
      ),
    ).toBe(
      "efficient learned index structures modern database systems in:readme",
    );
    expect(
      significantTitleTerms("The Design and Analysis of Algorithms"),
    ).toEqual(["design", "analysis", "algorithms"]);
    expect(requireGitHubScholarLimit("10")).toBe(10);
    expect(() => requireGitHubScholarLimit(11)).toThrow("[1, 10]");
  });

  it("adds optional GitHub authentication without requiring it", () => {
    expect(githubHeaders()).not.toHaveProperty("Authorization");
    process.env.GITHUB_TOKEN = "test-token";
    expect(githubHeaders()).toMatchObject({
      Authorization: "Bearer test-token",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });
});

describe("github scholar REST verification", () => {
  it("returns only repositories whose README has the exact requested DOI", async () => {
    // REASON: GitHub search and README retrieval are external boundaries; the test preserves their public REST envelopes.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/search/repositories?")) {
        return jsonResponse({
          total_count: 2,
          incomplete_results: false,
          items: [
            {
              full_name: "research/exact-code",
              html_url: "https://github.com/research/exact-code",
              description: "Candidate implementation",
              stargazers_count: 42,
              updated_at: "2026-08-01T00:00:00Z",
              license: { spdx_id: "MIT" },
            },
            {
              full_name: "research/nearby-paper",
              html_url: "https://github.com/research/nearby-paper",
              stargazers_count: 100,
            },
          ],
        });
      }
      if (url.includes("research/exact-code/readme")) {
        return readmeResponse(
          "Implements the paper with DOI https://doi.org/10.1145/3718958.3754348.",
          "research/exact-code",
        );
      }
      return readmeResponse(
        "Implements a neighboring paper DOI 10.1145/3718958.3754349.",
        "research/nearby-paper",
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const rows = await searchGitHubScholarRepositories(
      "10.1145/3718958.3754348",
      3,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "research/exact-code",
      doi: "10.1145/3718958.3754348",
      code_url: "https://github.com/research/exact-code",
      match_type: "doi_exact",
      confidence: 1,
      evidence: "repository-readme",
      relationship_evidence: ["implementation-language-near-paper-reference"],
      relationship: "candidate-implementation",
      is_official_code: false,
      github_stars: 42,
      repository_license: "MIT",
    });
    expect(rows[0].source_url).toContain("README.md");
    expect(rows[0].evidence_excerpt).toContain("10.1145/3718958.3754348");
    expect(rows[0].raw).toMatchObject({
      verification: "doi_exact",
      confidence: 1,
      evidence: "repository-readme",
      is_official_code: false,
      relationship_claim:
        "candidate implementation; author or publisher endorsement not verified",
    });
  });

  it("returns a high-overlap title match after reading README content", async () => {
    // REASON: GitHub search and README retrieval are external boundaries; the test preserves their public REST envelopes.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/search/repositories?")) {
        return jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              full_name: "lab/learned-indexes",
              html_url: "https://github.com/lab/learned-indexes",
              stargazers_count: 12,
            },
          ],
        });
      }
      return readmeResponse(
        "This repository implements efficient learned index structures in modern database systems.",
        "lab/learned-indexes",
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const title =
      "Efficient Learned Index Structures for Modern Database Systems";
    const rows = await searchGitHubScholarRepositories(title, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title,
      repository: "lab/learned-indexes",
      match_type: "title_overlap",
      title_overlap: 1,
      relationship: "candidate-implementation",
      is_official_code: false,
    });
  });

  it("scans the bounded candidate set before selecting the strongest evidence", async () => {
    // REASON: GitHub search and README retrieval are external boundaries; the test preserves their public REST envelopes.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/search/repositories?")) {
        return jsonResponse({
          total_count: 2,
          incomplete_results: false,
          items: [
            {
              full_name: "lab/high-overlap",
              html_url: "https://github.com/lab/high-overlap",
              stargazers_count: 500,
            },
            {
              full_name: "lab/exact-title",
              html_url: "https://github.com/lab/exact-title",
              stargazers_count: 5,
            },
          ],
        });
      }
      if (url.includes("lab/high-overlap/readme")) {
        return readmeResponse(
          "This repository implements efficient learned index structures in modern database systems.",
          "lab/high-overlap",
        );
      }
      return readmeResponse(
        "This repository implements Efficient Learned Index Structures for Modern Database Systems.",
        "lab/exact-title",
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const rows = await searchGitHubScholarRepositories(
      "Efficient Learned Index Structures for Modern Database Systems",
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repository: "lab/exact-title",
      match_type: "title_exact",
      confidence: 0.98,
    });
  });

  it("rejects a bibliography mention without implementation evidence", async () => {
    // REASON: GitHub search and README retrieval are external boundaries; the test preserves their public REST envelopes.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/search/repositories?")) {
        return jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              full_name: "survey/paper-reading-list",
              html_url: "https://github.com/survey/paper-reading-list",
              description: "A bibliography of database papers",
            },
          ],
        });
      }
      return readmeResponse(
        "Recommended reading: Efficient Learned Index Structures for Modern Database Systems. The next paper covers query optimization.",
        "survey/paper-reading-list",
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchGitHubScholarRepositories(
        "Efficient Learned Index Structures for Modern Database Systems",
        1,
      ),
    ).rejects.toMatchObject({ code: "empty_result" });
  });

  it("does not trust repository name or description without README evidence", async () => {
    // REASON: GitHub search and README retrieval are external boundaries; the test preserves their public REST envelopes.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/search/repositories?")) {
        return jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              full_name:
                "lab/efficient-learned-index-structures-modern-database-systems",
              html_url:
                "https://github.com/lab/efficient-learned-index-structures-modern-database-systems",
              description:
                "Efficient Learned Index Structures for Modern Database Systems",
            },
          ],
        });
      }
      return readmeResponse(
        "A collection of unrelated database utilities.",
        "lab/efficient-learned-index-structures-modern-database-systems",
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchGitHubScholarRepositories(
        "Efficient Learned Index Structures for Modern Database Systems",
        1,
      ),
    ).rejects.toMatchObject({
      code: "empty_result",
      retryable: false,
    });
  });

  it.each([
    [401, {}, "auth_error", false],
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited", true],
    [429, {}, "rate_limited", true],
    [500, {}, "upstream_error", true],
  ])(
    "maps GitHub HTTP %s to structured %s errors",
    async (status, headers, code, retryable) => {
      // REASON: GitHub HTTP failures are external boundaries; the test verifies their actionable error mapping.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({ message: "failure" }, status, headers),
        ),
      );
      await expect(
        searchGitHubScholarRepositories(
          "Efficient Learned Index Structures for Modern Database Systems",
          1,
        ),
      ).rejects.toMatchObject({ code, retryable });
    },
  );

  it("maps fetch timeouts to retryable structured errors", async () => {
    // REASON: A rejected fetch is the external timeout boundary under test.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }),
    );
    await expect(
      searchGitHubScholarRepositories(
        "Efficient Learned Index Structures for Modern Database Systems",
        1,
      ),
    ).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
      suggestion: expect.stringContaining("Retry"),
    });
  });

  it("preserves caller cancellation instead of classifying it as an upstream failure", async () => {
    // REASON: A caller-owned AbortSignal is the external cancellation boundary under test.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    );
    const controller = new AbortController();
    const reason = Object.assign(new Error("caller deadline"), {
      name: "TimeoutError",
    });
    const pending = searchGitHubScholarRepositories(
      "Efficient Learned Index Structures for Modern Database Systems",
      1,
      controller.signal,
    );
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("maps malformed GitHub JSON to a structured upstream error", async () => {
    // REASON: A malformed REST payload is an external response boundary under test.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(
      searchGitHubScholarRepositories(
        "Efficient Learned Index Structures for Modern Database Systems",
        1,
      ),
    ).rejects.toMatchObject({
      code: "upstream_error",
      retryable: true,
      message: expect.stringContaining("invalid JSON"),
    });
  });

  it("sends a bounded AbortSignal on every GitHub request", async () => {
    // REASON: GitHub search and README retrieval are external boundaries; the test inspects their timeout-bearing request options.
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        const url = String(input);
        if (url.includes("/search/repositories?")) {
          return jsonResponse({
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                full_name: "lab/verified",
                html_url: "https://github.com/lab/verified",
              },
            ],
          });
        }
        return readmeResponse(
          "This repository implements Efficient Learned Index Structures for Modern Database Systems.",
          "lab/verified",
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await searchGitHubScholarRepositories(
      "Efficient Learned Index Structures for Modern Database Systems",
      1,
    );
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});
