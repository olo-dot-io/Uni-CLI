import { describe, expect, it } from "vitest";

import {
  NormalizerError,
  assemblePatentRecord,
  buildPatentEnvelope,
  canonicalizePublicationNumber,
  dedupeByFamily,
} from "../../../../src/engine/normalizer/patent-envelope.js";
import type { PatentRecord } from "../../../../src/types/patent.js";

describe("canonicalizePublicationNumber", () => {
  it("splits a compact US grant into ST.16 segments", () => {
    expect(canonicalizePublicationNumber("US20240123456A1")).toBe(
      "US-20240123456-A1",
    );
  });

  it("splits a compact EP application", () => {
    expect(canonicalizePublicationNumber("EP4123456A1")).toBe("EP-4123456-A1");
  });

  it("passes through an already-segmented value", () => {
    expect(canonicalizePublicationNumber("US-20240123456-A1")).toBe(
      "US-20240123456-A1",
    );
  });

  it("uppercases lowercase inputs", () => {
    expect(canonicalizePublicationNumber("ep4123456a1")).toBe("EP-4123456-A1");
  });

  it("throws NormalizerError on empty or non-string input", () => {
    expect(() => canonicalizePublicationNumber("")).toThrow(NormalizerError);
  });

  it("throws NormalizerError on totally unparseable input", () => {
    expect(() => canonicalizePublicationNumber("???")).toThrow(NormalizerError);
  });
});

describe("assemblePatentRecord", () => {
  it("stamps retrieved_at and canonicalizes publication_number", () => {
    const before = Date.now();
    const record = assemblePatentRecord({
      publication_number: "US20240123456A1",
      source_adapter: "uspto",
      title: "Widget",
    });
    expect(record.publication_number).toBe("US-20240123456-A1");
    expect(record.source_adapter).toBe("uspto");
    expect(record.title).toBe("Widget");
    expect(Date.parse(record.retrieved_at)).toBeGreaterThanOrEqual(before);
  });

  it("throws NormalizerError when source_adapter is missing", () => {
    expect(() =>
      assemblePatentRecord({
        publication_number: "US20240123456A1",
        source_adapter: "",
      }),
    ).toThrow(NormalizerError);
  });

  it("throws NormalizerError when publication_number is missing", () => {
    expect(() =>
      assemblePatentRecord({
        publication_number: "",
        source_adapter: "uspto",
      }),
    ).toThrow(NormalizerError);
  });
});

describe("buildPatentEnvelope", () => {
  it("maps PATENT_AUTH_REQUIRED to exit 77", () => {
    const envelope = buildPatentEnvelope({
      code: "PATENT_AUTH_REQUIRED",
      adapter_path: "src/adapters/epo/get.yaml",
      step: "oauth2-token",
      suggestion: "set EPO_OPS_CLIENT_ID",
    });
    expect(envelope.exit_code).toBe(77);
    expect(envelope.retryable).toBe(false);
    expect(envelope.alternatives).toEqual([]);
  });

  it("maps PATENT_RATE_LIMIT to exit 75", () => {
    expect(
      buildPatentEnvelope({
        code: "PATENT_RATE_LIMIT",
        adapter_path: "p",
        step: "s",
        suggestion: "back off",
      }).exit_code,
    ).toBe(75);
  });

  it("maps PATENT_NOT_FOUND to exit 66", () => {
    expect(
      buildPatentEnvelope({
        code: "PATENT_NOT_FOUND",
        adapter_path: "p",
        step: "s",
        suggestion: "check the number",
      }).exit_code,
    ).toBe(66);
  });

  it("maps PATENT_API_DEPRECATED to exit 69", () => {
    expect(
      buildPatentEnvelope({
        code: "PATENT_API_DEPRECATED",
        adapter_path: "p",
        step: "s",
        suggestion: "use new endpoint",
      }).exit_code,
    ).toBe(69);
  });

  it("maps PATENT_INVALID_NUMBER to exit 65", () => {
    expect(
      buildPatentEnvelope({
        code: "PATENT_INVALID_NUMBER",
        adapter_path: "p",
        step: "s",
        suggestion: "fix",
      }).exit_code,
    ).toBe(65);
  });

  it("maps unknown taxonomy codes (browser captcha) to default 1", () => {
    expect(
      buildPatentEnvelope({
        code: "PATENT_BROWSER_CAPTCHA",
        adapter_path: "p",
        step: "s",
        suggestion: "open the browser",
      }).exit_code,
    ).toBe(1);
  });

  it("preserves retryable and alternatives when supplied", () => {
    const envelope = buildPatentEnvelope({
      code: "PATENT_RATE_LIMIT",
      adapter_path: "p",
      step: "s",
      suggestion: "back off",
      retryable: true,
      alternatives: ["espacenet/get"],
    });
    expect(envelope.retryable).toBe(true);
    expect(envelope.alternatives).toEqual(["espacenet/get"]);
  });
});

describe("dedupeByFamily", () => {
  function rec(partial: Partial<PatentRecord>): PatentRecord {
    return {
      publication_number: partial.publication_number ?? "US-1-A1",
      source_adapter: partial.source_adapter ?? "uspto",
      retrieved_at: partial.retrieved_at ?? new Date().toISOString(),
      ...partial,
    } as PatentRecord;
  }

  it("dedupes by family_id and preserves first-seen ordering", () => {
    const records: PatentRecord[] = [
      rec({ publication_number: "US-1-A1", family_id: "fam-1" }),
      rec({ publication_number: "EP-2-A1", family_id: "fam-1" }),
      rec({ publication_number: "JP-3-A", family_id: "fam-2" }),
      rec({ publication_number: "CN-4-B", family_id: "fam-2" }),
    ];
    const out = dedupeByFamily(records);
    expect(out).toHaveLength(2);
    expect(out[0].publication_number).toBe("US-1-A1");
    expect(out[1].publication_number).toBe("JP-3-A");
  });

  it("falls back to canonical publication_number when family_id is missing", () => {
    const out = dedupeByFamily([
      rec({ publication_number: "US20240123456A1" }),
      rec({ publication_number: "US-20240123456-A1" }),
      rec({ publication_number: "EP-4123456-A1" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].publication_number).toBe("US20240123456A1");
    expect(out[1].publication_number).toBe("EP-4123456-A1");
  });
});
