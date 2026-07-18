import { describe, expect, it } from "vitest";

import { projectGoogleRowToRecord } from "./_shared.js";

describe("google patents search row projection", () => {
  it("links normalized candidates to the patent detail and cleans title markup", () => {
    const record = projectGoogleRowToRecord(
      {
        id: "patent/US11741034B2/en",
        patent: {
          publication_number: "US11741034B2",
          title: "<b>Memory device</b> &hellip;",
          snippet: "A <b>coherent</b> interconnect",
        },
      },
      "https://patents.google.com/xhr/query?url=q%3DNVLink",
    );

    expect(record).toMatchObject({
      title: "Memory device …",
      abstract: "A coherent interconnect",
      source_url: "https://patents.google.com/patent/US11741034B2/en",
    });
  });
});
