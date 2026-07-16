import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateOperationPolicy } from "../../src/engine/operation-policy.js";
import { browserOperatorEffect } from "../../src/commands/browser/permission.js";
import {
  createPermissionRulesStore,
  findDenyRuleForPolicySync,
  findDenyRuleForRuntimeResourceSync,
} from "../../src/engine/permission-rules.js";

describe("permission deny rules", () => {
  it("classifies browser upload as a UI mutation rather than a local file write", () => {
    expect(
      browserOperatorEffect("upload", {
        ref: "@e7",
        path: "/tmp/report.pdf",
      }),
    ).toBe("local_app");
  });

  it("fails closed when an explicitly configured file is missing", () => {
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

      expect(() =>
        findDenyRuleForPolicySync(policy, { path: store.path }),
      ).toThrowError(/configured permission rules file does not exist/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the implicit default path optional", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-default-missing-"));
    try {
      const policy = evaluateOperationPolicy({
        site: "twitter",
        command: "post",
      });
      expect(findDenyRuleForPolicySync(policy, { homeDir: tmp })).toBe(
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

  it("rejects unsupported policy formats instead of guessing a parser", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-format-"));
    try {
      const path = join(tmp, "permission-rules.rego");
      writeFileSync(path, "package unicli.policy", "utf-8");
      const policy = evaluateOperationPolicy({
        site: "browser",
        command: "click",
      });

      expect(() => findDenyRuleForPolicySync(policy, { path })).toThrowError(
        /expected \.json, \.yaml, or \.yml/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects non-file policy paths separately from malformed JSON", () => {
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
      ).toThrowError(/not a regular file/);
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

  it("matches direct policy resources at parent-domain boundaries", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-boundary-"));
    try {
      const path = join(tmp, "permission-rules.json");
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: "1",
          rules: [
            {
              id: "deny-resource-boundary",
              decision: "deny",
              match: {
                resources: {
                  domains: ["example.com"],
                },
              },
              reason: "resource subtree is blocked",
            },
          ],
        }),
        "utf-8",
      );
      const policy = evaluateOperationPolicy({
        site: "browser",
        command: "open",
        adapterType: "browser",
        targetSurface: "web",
        strategy: "ui",
        browser: true,
        domain: "api.example.com",
      });

      expect(findDenyRuleForPolicySync(policy, { path })).toMatchObject({
        id: "deny-resource-boundary",
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

  it("matches runtime resources by host boundary and path prefix", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-runtime-"));
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
              id: "deny-runtime-private-zone",
              decision: "deny",
              match: {
                resources: {
                  domains: ["example.com"],
                  paths: ["/private"],
                },
              },
              reason: "runtime resource is blocked",
            },
          ],
        }),
        "utf-8",
      );

      expect(
        findDenyRuleForRuntimeResourceSync(
          {
            resources: {
              domains: ["api.example.com"],
              paths: ["/private/report.json"],
            },
          },
          { path: store.path },
        ),
      ).toEqual({
        decision: "deny",
        id: "deny-runtime-private-zone",
        reason: "runtime resource is blocked",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("matches runtime domains with trailing fully-qualified dots", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-fqdn-dot-"));
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
              id: "deny-fqdn-dot",
              decision: "deny",
              match: {
                resources: {
                  domains: ["example.com"],
                },
              },
              reason: "runtime domain is blocked",
            },
          ],
        }),
        "utf-8",
      );

      expect(
        findDenyRuleForRuntimeResourceSync(
          {
            resources: {
              domains: ["api.example.com."],
            },
          },
          { path: store.path },
        ),
      ).toEqual({
        decision: "deny",
        id: "deny-fqdn-dot",
        reason: "runtime domain is blocked",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies v2 allow rules and default-deny to runtime resources", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-runtime-v2-"));
    try {
      const path = join(tmp, "permission-rules.yaml");
      writeFileSync(
        path,
        [
          "schema_version: '2'",
          "default: deny",
          "rules:",
          "  - id: allow-bounded-api",
          "    decision: allow",
          "    match:",
          "      resources:",
          "        domains: [example.com]",
          "      arguments:",
          "        tenant:",
          "          allowed: [public]",
          "    reason: bounded API access",
          "",
        ].join("\n"),
        "utf-8",
      );

      expect(
        findDenyRuleForRuntimeResourceSync(
          {
            resources: { domains: ["api.example.com"] },
            argumentValues: { tenant: "public" },
          },
          { path },
        ),
      ).toBeUndefined();
      expect(
        findDenyRuleForRuntimeResourceSync(
          {
            resources: { domains: ["127.0.0.1"] },
            argumentValues: { tenant: "public" },
          },
          { path },
        ),
      ).toEqual({
        decision: "deny",
        id: "policy-default-deny",
        reason:
          "no allow rule matched and the permission policy defaults to deny",
      });
      expect(
        findDenyRuleForRuntimeResourceSync(
          {
            resources: { domains: ["api.example.com"] },
            argumentValues: { tenant: "private" },
          },
          { path },
        ),
      ).toMatchObject({ id: "policy-default-deny" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("matches runtime Windows paths with backslash separators", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-windows-path-"));
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
              id: "deny-windows-private-zone",
              decision: "deny",
              match: {
                resources: {
                  paths: ["C:\\Temp\\private"],
                },
              },
              reason: "runtime path is blocked",
            },
          ],
        }),
        "utf-8",
      );

      expect(
        findDenyRuleForRuntimeResourceSync(
          {
            resources: {
              paths: ["C:\\Temp\\private\\report.json"],
            },
          },
          { path: store.path },
        ),
      ).toEqual({
        decision: "deny",
        id: "deny-windows-private-zone",
        reason: "runtime path is blocked",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("matches runtime executables by absolute path basename", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-executable-"));
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
              id: "deny-bash-runtime",
              decision: "deny",
              match: {
                resources: {
                  executables: ["bash"],
                },
              },
              reason: "shell execution is blocked",
            },
          ],
        }),
        "utf-8",
      );

      expect(
        findDenyRuleForRuntimeResourceSync(
          {
            resources: {
              executables: ["/bin/bash"],
            },
          },
          { path: store.path },
        ),
      ).toEqual({
        decision: "deny",
        id: "deny-bash-runtime",
        reason: "shell execution is blocked",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parses YAML v2 default-deny policies with bounded argument constraints", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-yaml-v2-"));
    try {
      const path = join(tmp, "permission-rules.yaml");
      writeFileSync(
        path,
        [
          'schema_version: "2"',
          "default: deny",
          "rules:",
          "  - id: allow-short-status",
          "    decision: allow",
          "    match:",
          "      site: compute",
          "      command: type",
          "      effect: local_app",
          "      arguments:",
          "        text:",
          "          max_length: 12",
          '          pattern: "^[a-z ]+$"',
          "          allowed:",
          "            - ready",
          "            - all systems",
          "    reason: bounded status text",
          "",
        ].join("\n"),
        "utf-8",
      );
      const policy = evaluateOperationPolicy({
        site: "compute",
        command: "type",
        adapterType: "desktop",
        targetSurface: "desktop",
        effect: "local_app",
      });

      expect(
        findDenyRuleForPolicySync(policy, {
          path,
          argumentValues: { text: "ready" },
        }),
      ).toBe(undefined);
      expect(
        findDenyRuleForPolicySync(policy, {
          path,
          argumentValues: { text: "NOT READY" },
        }),
      ).toEqual({
        decision: "deny",
        id: "policy-default-deny",
        reason:
          "no allow rule matched and the permission policy defaults to deny",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies matching deny rules before matching allow rules", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-deny-first-"));
    try {
      const path = join(tmp, "permission-rules.json");
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: "2",
          default: "deny",
          rules: [
            {
              id: "allow-compute-click",
              decision: "allow",
              match: { site: "compute", command: "click" },
            },
            {
              id: "deny-admin-ref",
              decision: "deny",
              match: {
                site: "compute",
                command: "click",
                arguments: { ref: { allowed: ["@e-admin"] } },
              },
              reason: "admin control is blocked",
            },
          ],
        }),
        "utf-8",
      );
      const policy = evaluateOperationPolicy({
        site: "compute",
        command: "click",
        adapterType: "desktop",
        targetSurface: "desktop",
        effect: "local_app",
      });

      expect(
        findDenyRuleForPolicySync(policy, {
          path,
          argumentValues: { ref: "@e-admin" },
        }),
      ).toEqual({
        decision: "deny",
        id: "deny-admin-ref",
        reason: "admin control is blocked",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("supports inclusive numeric argument bounds", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-numeric-v2-"));
    try {
      const path = join(tmp, "permission-rules.json");
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: "2",
          default: "deny",
          rules: [
            {
              id: "allow-bounded-scroll",
              decision: "allow",
              match: {
                site: "compute",
                command: "scroll",
                arguments: { amount: { min: 1, max: 500 } },
              },
            },
          ],
        }),
        "utf-8",
      );
      const policy = evaluateOperationPolicy({
        site: "compute",
        command: "scroll",
        adapterType: "desktop",
        targetSurface: "desktop",
        effect: "local_app",
      });

      expect(
        findDenyRuleForPolicySync(policy, {
          path,
          argumentValues: { amount: 500 },
        }),
      ).toBe(undefined);
      expect(
        findDenyRuleForPolicySync(policy, {
          path,
          argumentValues: { amount: 501 },
        })?.id,
      ).toBe("policy-default-deny");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects non-RE2 patterns and YAML aliases", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-rules-strict-yaml-"));
    try {
      const patternPath = join(tmp, "pattern.yaml");
      writeFileSync(
        patternPath,
        [
          'schema_version: "2"',
          "default: deny",
          "rules:",
          "  - id: bad-pattern",
          "    decision: allow",
          "    match:",
          "      arguments:",
          "        text:",
          '          pattern: "(?=a)a"',
        ].join("\n"),
        "utf-8",
      );
      const aliasPath = join(tmp, "alias.yaml");
      writeFileSync(
        aliasPath,
        [
          'schema_version: "2"',
          "default: deny",
          "rules:",
          "  - &rule",
          "    id: base",
          "    decision: allow",
          "    match: {}",
          "  - *rule",
        ].join("\n"),
        "utf-8",
      );
      const policy = evaluateOperationPolicy({
        site: "compute",
        command: "type",
      });

      expect(() =>
        findDenyRuleForPolicySync(policy, { path: patternPath }),
      ).toThrowError(/invalid RE2 syntax/);
      expect(() =>
        findDenyRuleForPolicySync(policy, { path: aliasPath }),
      ).toThrowError(/alias (count|resolution)|resource exhaustion/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
