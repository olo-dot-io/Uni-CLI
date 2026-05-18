import { describe, expect, it } from "vitest";

import { stepSelectXml } from "../../../../src/engine/steps/select-xml.js";
import { PipelineError } from "../../../../src/engine/executor.js";

const OPS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<ops:world-patent-data xmlns:ops="http://ops.epo.org" xmlns:exchange="http://exchange.epo.org">
  <ops:exchange-documents>
    <ops:exchange-document country="EP" doc-number="4123456" kind="A1">
      <exchange:bibliographic-data>
        <exchange:publication-reference>
          <exchange:document-id format="docdb">
            <exchange:country>EP</exchange:country>
            <exchange:doc-number>4123456</exchange:doc-number>
            <exchange:kind>A1</exchange:kind>
          </exchange:document-id>
        </exchange:publication-reference>
        <exchange:invention-title lang="en">Method and apparatus for X</exchange:invention-title>
      </exchange:bibliographic-data>
    </ops:exchange-document>
    <ops:exchange-document country="EP" doc-number="4123457" kind="B1">
      <exchange:bibliographic-data>
        <exchange:invention-title lang="en">Second invention</exchange:invention-title>
      </exchange:bibliographic-data>
    </ops:exchange-document>
  </ops:exchange-documents>
</ops:world-patent-data>`;

function run(xpath: string, opts?: { unwrap_single?: boolean }) {
  const ctx = { data: OPS_FIXTURE, args: {}, vars: {} };
  const next = stepSelectXml(ctx, {
    xpath,
    namespaces: {
      ops: "http://ops.epo.org",
      exchange: "http://exchange.epo.org",
    },
    unwrap_single: opts?.unwrap_single,
  });
  return next.data;
}

describe("select-xml step", () => {
  it("selects child via absolute path with namespace prefix", () => {
    const out = run(
      "/ops:world-patent-data/ops:exchange-documents/ops:exchange-document",
    );
    expect(Array.isArray(out)).toBe(true);
    expect((out as unknown[]).length).toBe(2);
  });

  it("selects descendant via // axis", () => {
    const out = run("//exchange:invention-title");
    expect(Array.isArray(out)).toBe(true);
    expect((out as unknown[]).length).toBe(2);
  });

  it("filters by attribute-equality predicate", () => {
    const out = run(
      "/ops:world-patent-data/ops:exchange-documents/ops:exchange-document[@kind='B1']",
    );
    expect(Array.isArray(out)).toBe(true);
    expect((out as unknown[]).length).toBe(1);
    expect((out as Array<Record<string, unknown>>)[0]["@_doc-number"]).toBe(
      "4123457",
    );
  });

  it("supports positional predicate (1-indexed)", () => {
    const out = run(
      "/ops:world-patent-data/ops:exchange-documents/ops:exchange-document[1]",
    );
    expect((out as unknown[]).length).toBe(1);
    expect((out as Array<Record<string, unknown>>)[0]["@_kind"]).toBe("A1");
  });

  it("returns an attribute value via @attr terminal step", () => {
    const out = run(
      "/ops:world-patent-data/ops:exchange-documents/ops:exchange-document[1]/@kind",
    );
    expect(out).toEqual(["A1"]);
  });

  it("unwraps a single-element result when unwrap_single is true", () => {
    const out = run(
      "/ops:world-patent-data/ops:exchange-documents/ops:exchange-document[@kind='B1']",
      { unwrap_single: true },
    );
    expect(Array.isArray(out)).toBe(false);
    expect((out as Record<string, unknown>)["@_doc-number"]).toBe("4123457");
  });

  it("throws PipelineError when ctx.data is not a string", () => {
    expect(() =>
      stepSelectXml(
        { data: { not: "xml" }, args: {}, vars: {} },
        { xpath: "/foo" },
      ),
    ).toThrow(PipelineError);
  });

  it("throws PipelineError on an unsupported xpath", () => {
    expect(() => run("/ops:world-patent-data[contains(@x,'y')]")).toThrow(
      PipelineError,
    );
  });

  it("returns an empty list when xpath misses on a structurally valid document", () => {
    const ctx = {
      data: "<root><a/></root>",
      args: {},
      vars: {},
    };
    const next = stepSelectXml(ctx, { xpath: "/root/missing" });
    expect(next.data).toEqual([]);
  });
});
