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
