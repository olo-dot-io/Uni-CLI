import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateOperationPolicy } from "../../src/engine/operation-policy.js";
import {
  createPermissionRulesStore,
  findDenyRuleForPolicySync,
} from "../../src/engine/permission-rules.js";

describe("permission deny rules", () => {
  it("returns no rule when the configured file is missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-missing-"));
    try {
      const store = createPermissionRulesStore({
        path: join(tmp, "permission-rules.json"),
      });
      const policy = evaluateOperationPolicy({
        site: "twitter",
        command: "post",
        description: "Post a tweet",
        adapterType: "web-api",
        targetSurface: "web",
        strategy: "cookie",
        domain: "x.com",
      });

      expect(findDenyRuleForPolicySync(policy, { path: store.path })).toBe(
        undefined,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the configured file contains malformed JSON", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-malformed-"));
    try {
      const store = createPermissionRulesStore({
        path: join(tmp, "permission-rules.json"),
      });
      writeFileSync(store.path, '{"schema_version":', "utf-8");
      const policy = evaluateOperationPolicy({
        site: "twitter",
        command: "post",
      });

      expect(() =>
        findDenyRuleForPolicySync(policy, { path: store.path }),
      ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports unreadable rule files separately from malformed JSON", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-unreadable-"));
    try {
      const store = createPermissionRulesStore({
        path: join(tmp, "permission-rules.json"),
      });
      mkdirSync(store.path);
      const policy = evaluateOperationPolicy({
        site: "twitter",
        command: "post",
      });

      expect(() =>
        findDenyRuleForPolicySync(policy, { path: store.path }),
      ).toThrowError(/failed to read permission rules file/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects unknown decisions instead of ignoring them", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-decision-"));
    try {
      const store = createPermissionRulesStore({
        path: join(tmp, "permission-rules.json"),
      });
      writeFileSync(
        store.path,
        JSON.stringify({
          schema_version: "1",
          rules: [
            {
              id: "maybe-post",
              decision: "ask",
              match: { site: "twitter" },
              reason: "not a supported decision",
            },
          ],
        }),
        "utf-8",
      );
      const policy = evaluateOperationPolicy({
        site: "twitter",
        command: "post",
      });

      expect(() =>
        findDenyRuleForPolicySync(policy, { path: store.path }),
      ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("matches valid deny rules by site, effect, and resource domain", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-match-"));
    try {
      const store = createPermissionRulesStore({
        path: join(tmp, "permission-rules.json"),
      });
      writeFileSync(
        store.path,
        JSON.stringify({
          schema_version: "1",
          rules: [
            {
              id: "deny-public-posting",
              decision: "deny",
              match: {
                site: "twitter",
                effect: "publish_content",
                resources: {
                  domains: ["twitter.com", "x.com"],
                },
              },
              reason: "Do not publish from this machine",
            },
          ],
        }),
        "utf-8",
      );
      const policy = evaluateOperationPolicy({
        site: "twitter",
        command: "post",
        description: "Post a tweet",
        adapterType: "web-api",
        targetSurface: "web",
        strategy: "cookie",
        domain: "x.com",
      });

      expect(findDenyRuleForPolicySync(policy, { path: store.path })).toEqual({
        decision: "deny",
        id: "deny-public-posting",
        reason: "Do not publish from this machine",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("matches sites that contain dots", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-dotted-site-"));
    try {
      const store = createPermissionRulesStore({
        path: join(tmp, "permission-rules.json"),
      });
      writeFileSync(
        store.path,
        JSON.stringify({
          schema_version: "1",
          rules: [
            {
              id: "deny-dotted-site",
              decision: "deny",
              match: {
                site: "github.com",
                command: "search",
              },
              reason: "Do not query this host",
            },
          ],
        }),
        "utf-8",
      );
      const policy = evaluateOperationPolicy({
        site: "github.com",
        command: "search",
        description: "Search GitHub",
        adapterType: "web-api",
        targetSurface: "web",
        strategy: "public",
        domain: "github.com",
      });

      expect(findDenyRuleForPolicySync(policy, { path: store.path })).toEqual({
        decision: "deny",
        id: "deny-dotted-site",
        reason: "Do not query this host",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
