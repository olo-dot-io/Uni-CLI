import { describe, expect, it } from "vitest";

import {
  assertCommandAvailable,
  CommandUnavailableError,
  evaluateCommandAvailability,
  isCommandDiscoverable,
} from "../../src/core/command-availability.js";

const availability = {
  environment: ["SEARCH_API_KEY"],
  discovery: "configured" as const,
  setup_url: "https://search.example.com/keys",
};

describe("command configuration availability", () => {
  it("hides configured-only commands until every declared variable is present", () => {
    expect(evaluateCommandAvailability(availability, {})).toEqual({
      state: "missing_configuration",
      ready: false,
      discovery: "configured",
      required_environment: ["SEARCH_API_KEY"],
      missing_environment: ["SEARCH_API_KEY"],
      setup_url: "https://search.example.com/keys",
    });
    expect(isCommandDiscoverable({ availability }, {})).toBe(false);
    expect(
      isCommandDiscoverable({ availability }, { SEARCH_API_KEY: "configured" }),
    ).toBe(true);
  });

  it("keeps always-discovered commands visible while blocking execution", () => {
    const command = {
      availability: { environment: ["TOKEN"], discovery: "always" as const },
    };
    expect(isCommandDiscoverable(command, {})).toBe(true);
    expect(() =>
      assertCommandAvailable("provider.search", command, {}),
    ).toThrow(CommandUnavailableError);
  });

  it("returns a provider-specific configuration action", () => {
    expect(() =>
      assertCommandAvailable("search.search", { availability }, {}),
    ).toThrowError(
      expect.objectContaining({
        code: "auth_required",
        retryable: false,
        suggestion: expect.stringContaining("https://search.example.com/keys"),
      }),
    );
  });
});
