import { describe, expect, it } from "vitest";

import {
  buildCapabilityApprovalMemory,
  deriveCapabilityScope,
} from "../../src/engine/capability-policy.js";

describe("capability-scoped permission classifier", () => {
  it("classifies read-only web commands as network reads without write dimensions", () => {
    const scope = deriveCapabilityScope(
      {
        site: "google",
        command: "search",
        description: "Search Google",
        adapterType: "web-api",
        targetSurface: "web",
        strategy: "public",
      },
      "read",
    );

    expect(scope.dimensions.network.access).toBe("read");
    expect(scope.dimensions.browser.access).toBe("none");
    expect(scope.dimensions.account.access).toBe("none");
    expect(scope.dimensions.file.access).toBe("none");
    expect(scope.summary).toContain("network:read");
  });

  it("classifies publish commands as account and network writes", () => {
    const scope = deriveCapabilityScope(
      {
        site: "twitter",
        command: "post",
        description: "Post a tweet",
        adapterType: "browser",
        targetSurface: "web",
        browser: true,
      },
      "publish_content",
    );

    expect(scope.dimensions.network.access).toBe("write");
    expect(scope.dimensions.browser.access).toBe("write");
    expect(scope.dimensions.account.access).toBe("write");
    expect(scope.dimensions.desktop.access).toBe("none");
  });

  it("classifies desktop app commands as desktop and process writes", () => {
    const scope = deriveCapabilityScope(
      {
        site: "wechat-work",
        command: "type-text",
        description: "Type text into the focused desktop field",
        adapterType: "web-api",
        targetSurface: "desktop",
      },
      "local_app",
    );

    expect(scope.dimensions.desktop.access).toBe("write");
    expect(scope.dimensions.process.access).toBe("write");
    expect(scope.dimensions.network.access).toBe("none");
  });

  it("classifies file-producing commands as file writes", () => {
    const scope = deriveCapabilityScope(
      {
        site: "macos",
        command: "screenshot",
        description: "Capture a screenshot",
        adapterType: "desktop",
        targetSurface: "system",
      },
      "local_file",
    );

    expect(scope.dimensions.file.access).toBe("write");
    expect(scope.dimensions.process.access).toBe("write");
  });

  it("classifies destructive local commands as file/process writes, not account writes", () => {
    const scope = deriveCapabilityScope(
      {
        site: "macos",
        command: "empty-trash",
        description: "Empty the macOS Trash",
        adapterType: "desktop",
        targetSurface: "system",
      },
      "destructive",
    );

    expect(scope.dimensions.file.access).toBe("write");
    expect(scope.dimensions.process.access).toBe("write");
    expect(scope.dimensions.account.access).toBe("none");
    expect(scope.dimensions.network.access).toBe("none");
  });

  it("classifies destructive web commands as remote account writes", () => {
    const scope = deriveCapabilityScope(
      {
        site: "twitter",
        command: "delete",
        description: "Delete your own tweet",
        adapterType: "web-api",
        targetSurface: "web",
        strategy: "cookie",
      },
      "destructive",
    );

    expect(scope.dimensions.network.access).toBe("write");
    expect(scope.dimensions.account.access).toBe("write");
    expect(scope.dimensions.file.access).toBe("none");
    expect(scope.dimensions.process.access).toBe("none");
  });

  it("classifies service state changes as network writes without local process/file claims", () => {
    const scope = deriveCapabilityScope(
      {
        site: "wiremock",
        command: "reset",
        description: "Reset WireMock server",
        adapterType: "service",
        targetSurface: "system",
        strategy: "public",
      },
      "service_state",
    );

    expect(scope.dimensions.network.access).toBe("write");
    expect(scope.dimensions.browser.access).toBe("none");
    expect(scope.dimensions.account.access).toBe("none");
    expect(scope.dimensions.file.access).toBe("none");
    expect(scope.dimensions.process.access).toBe("none");
  });

  it("classifies browser-mediated remote transforms as network/browser writes only", () => {
    const scope = deriveCapabilityScope(
      {
        site: "yollomi",
        command: "remove-bg",
        description: "Remove background from image (free)",
        adapterType: "web-api",
        targetSurface: "web",
        strategy: "intercept",
        browser: true,
      },
      "remote_transform",
    );

    expect(scope.dimensions.network.access).toBe("write");
    expect(scope.dimensions.browser.access).toBe("write");
    expect(scope.dimensions.account.access).toBe("none");
    expect(scope.dimensions.file.access).toBe("none");
    expect(scope.dimensions.process.access).toBe("none");
  });

  it("classifies remote resource changes as account-scoped network writes", () => {
    const scope = deriveCapabilityScope(
      {
        site: "linear",
        command: "issue-create",
        description: "Create a new Linear issue",
        adapterType: "web-api",
        targetSurface: "web",
        strategy: "public",
      },
      "remote_resource",
    );

    expect(scope.dimensions.network.access).toBe("write");
    expect(scope.dimensions.account.access).toBe("write");
    expect(scope.dimensions.browser.access).toBe("none");
    expect(scope.dimensions.file.access).toBe("none");
    expect(scope.dimensions.process.access).toBe("none");
  });

  it("does not put site fallbacks in the domains resource bucket", () => {
    const scope = deriveCapabilityScope(
      {
        site: "unknown-host-site",
        command: "search",
        description: "Search without explicit host metadata",
        adapterType: "web-api",
        targetSurface: "web",
        strategy: "public",
      },
      "read",
    );

    expect(scope.dimensions.network.access).toBe("read");
    expect(scope.resources.domains).toEqual([]);
    expect(scope.resource_summary).not.toContain(
      "domain:site:unknown-host-site",
    );
  });

  it("binds remote account approvals to stable resource metadata", () => {
    const scope = deriveCapabilityScope(
      {
        site: "linear",
        command: "issue-create",
        description: "Create a new Linear issue",
        adapterType: "web-api",
        targetSurface: "web",
        strategy: "public",
        domain: "api.linear.app",
      },
      "remote_resource",
    );

    const resources = (
      scope as {
        resources?: {
          domains: string[];
          accounts: string[];
        };
        resource_summary?: string[];
      }
    ).resources;
    expect(resources?.domains).toEqual(["api.linear.app"]);
    expect(resources?.accounts).toEqual(["linear"]);
    expect((scope as { resource_summary?: string[] }).resource_summary).toEqual(
      expect.arrayContaining(["domain:api.linear.app", "account:linear"]),
    );

    const first = buildCapabilityApprovalMemory({
      site: "linear",
      command: "issue-create",
      profile: "locked",
      effect: "remote_resource",
      approved: true,
      scope,
    });
    const second = buildCapabilityApprovalMemory({
      site: "linear",
      command: "issue-create",
      profile: "locked",
      effect: "remote_resource",
      approved: true,
      scope,
    });

    expect(first.key).toBe(second.key);
    expect(first.key).toContain(":res:");
    expect(first.key).not.toContain("hello");
    expect(
      (
        first.scope as {
          resources?: { domains: string[]; accounts: string[] };
        }
      ).resources,
    ).toMatchObject({
      domains: ["api.linear.app"],
      accounts: ["linear"],
    });
  });

  it("binds local file approvals to path argument slots without runtime values", () => {
    const scope = deriveCapabilityScope(
      {
        site: "chatgpt",
        command: "screenshot",
        description: "Capture a screenshot from desktop AI chat app",
        adapterType: "desktop",
        targetSurface: "desktop",
        args: [
          {
            name: "path",
            required: false,
          },
        ],
      },
      "local_file",
    );

    const resources = (
      scope as {
        resources?: {
          apps: string[];
          executables: string[];
          paths: string[];
        };
        resource_summary?: string[];
      }
    ).resources;

    expect(resources?.apps).toEqual(["chatgpt"]);
    expect(resources?.executables).toEqual(["chatgpt"]);
    expect(resources?.paths).toEqual(["arg:path"]);
    expect((scope as { resource_summary?: string[] }).resource_summary).toEqual(
      expect.arrayContaining(["app:chatgpt", "path:arg:path"]),
    );
  });

  it("builds deterministic non-persistent approval memory keys without raw args", () => {
    const scope = deriveCapabilityScope(
      {
        site: "slack",
        command: "send",
        description: "Send a message",
        adapterType: "web-api",
        targetSurface: "web",
      },
      "send_message",
    );

    const first = buildCapabilityApprovalMemory({
      site: "slack",
      command: "send",
      profile: "confirm",
      effect: "send_message",
      approved: false,
      scope,
    });
    const second = buildCapabilityApprovalMemory({
      site: "slack",
      command: "send",
      profile: "confirm",
      effect: "send_message",
      approved: false,
      scope,
    });

    expect(first).toEqual(second);
    expect(first.key).toContain("slack.send");
    expect(first.key).not.toContain("hello");
    expect(first.persistence).toBe("not_persisted");
    expect(first.decision).toBe("not_approved");
  });
});
