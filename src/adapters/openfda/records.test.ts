import { describe, expect, it } from "vitest";
import {
  buildFoodRecallSearch,
  firstOpenfdaValue,
  joinOpenfdaValues,
  mapDrugLabelRows,
  mapFoodRecallRows,
  requireOpenfdaLimit,
} from "./records.js";

describe("openfda agent-facing records commands", () => {
  it("validates limits and collapses FDA arrays", () => {
    expect(requireOpenfdaLimit(undefined, 5, 25)).toBe(5);
    expect(requireOpenfdaLimit("25", 5, 25)).toBe(25);
    expect(() => requireOpenfdaLimit("26", 5, 25)).toThrow(
      "openfda limit must",
    );
    expect(firstOpenfdaValue([" Aspirin "])).toBe("Aspirin");
    expect(joinOpenfdaValues(["oral", "tablet"])).toBe("oral, tablet");
  });

  it("builds food recall Lucene query strings", () => {
    expect(
      buildFoodRecallSearch({
        classification: "Class I",
        query: "salmonella",
        status: "Ongoing",
      }),
    ).toBe(
      "salmonella+AND+status%3A%22Ongoing%22+AND+classification%3A%22Class%20I%22",
    );
  });

  it("maps drug label rows", () => {
    expect(
      mapDrugLabelRows([
        {
          id: "set-id",
          openfda: {
            brand_name: ["Aspirin"],
            generic_name: ["aspirin"],
            manufacturer_name: ["Maker"],
            product_type: ["HUMAN OTC DRUG"],
            route: ["ORAL"],
            product_ndc: ["0000-0000"],
            pharm_class_epc: ["NSAID"],
          },
          purpose: ["Pain reliever"],
          indications_and_usage: ["For pain"],
          warnings: ["Ask a doctor"],
          dosage_and_administration: ["Take with water"],
          effective_time: "20260101",
        },
      ]),
    ).toMatchObject([
      {
        rank: 1,
        id: "set-id",
        brandName: "Aspirin",
        genericName: "aspirin",
        route: "ORAL",
        pharmClass: "NSAID",
        purpose: "Pain reliever",
      },
    ]);
  });

  it("maps food recall rows", () => {
    expect(
      mapFoodRecallRows([
        {
          recall_number: "F-0001-2026",
          status: "Ongoing",
          classification: "Class I",
          recalling_firm: "Firm",
          product_description: "Food",
          report_date: "20260512",
        },
      ]),
    ).toMatchObject([
      {
        rank: 1,
        recallNumber: "F-0001-2026",
        status: "Ongoing",
        classification: "Class I",
        recallingFirm: "Firm",
      },
    ]);
  });
});
