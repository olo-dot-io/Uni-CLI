import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateOperationPolicy,
  inferOperationEffect,
  InvalidPermissionProfileError,
  resolvePermissionProfile,
} from "../../src/engine/operation-policy.js";

const originalProfile = process.env.UNICLI_PERMISSION_PROFILE;
const originalApprove = process.env.UNICLI_APPROVE;

describe("operation policy", () => {
  beforeEach(() => {
    delete process.env.UNICLI_PERMISSION_PROFILE;
    delete process.env.UNICLI_APPROVE;
  });

  afterEach(() => {
    if (originalProfile === undefined) {
      delete process.env.UNICLI_PERMISSION_PROFILE;
    } else {
      process.env.UNICLI_PERMISSION_PROFILE = originalProfile;
    }
    if (originalApprove === undefined) {
      delete process.env.UNICLI_APPROVE;
    } else {
      process.env.UNICLI_APPROVE = originalApprove;
    }
  });

  it("defaults to open even for high-impact message commands", () => {
    const policy = evaluateOperationPolicy({
      site: "slack",
      command: "send",
      args: [{ name: "text", required: true }],
    });

    expect(policy).toMatchObject({
      profile: "open",
      effect: "send_message",
      risk: "high",
      approval_required: false,
      enforcement: "allow",
      capability_scope: {
        dimensions: {
          account: { access: "write" },
          network: { access: "write" },
        },
      },
      approval_memory: {
        persistence: "not_persisted",
        decision: "not_approved",
      },
    });
  });

  it("lets users opt into confirmation for high-impact writes", () => {
    const policy = evaluateOperationPolicy({
      site: "twitter",
      command: "post",
      args: [{ name: "text", required: true }],
      profile: "confirm",
    });

    expect(policy).toMatchObject({
      profile: "confirm",
      effect: "publish_content",
      approval_required: true,
      enforcement: "needs_approval",
    });
  });

  it("accepts explicit approval in strict profiles", () => {
    const policy = evaluateOperationPolicy({
      site: "instagram",
      command: "follow",
      profile: "locked",
      approved: true,
    });

    expect(policy).toMatchObject({
      profile: "locked",
      effect: "account_state",
      risk: "medium",
      approval_required: true,
      approved: true,
      enforcement: "allow",
      approval_memory: {
        decision: "approved_for_invocation",
      },
    });
  });

  it("does not classify read-style post detail commands as publishing", () => {
    const effect = inferOperationEffect({
      site: "jike",
      command: "post",
      description: "Jike post detail with comments",
      args: [{ name: "id", required: true }],
    });

    expect(effect).toBe("read");
  });

  it("keeps read-only desktop inspection commands open in locked profile", () => {
    const policy = evaluateOperationPolicy({
      site: "macos",
      command: "dark-mode",
      description: "Get current dark mode status",
      adapterType: "desktop",
      profile: "locked",
    });

    expect(policy).toMatchObject({
      effect: "read",
      risk: "low",
      enforcement: "allow",
    });
  });

  it("defaults to open when no profile is configured", () => {
    expect(resolvePermissionProfile()).toBe("open");
  });

  it("rejects unknown explicit profile names instead of failing open", () => {
    expect(() => resolvePermissionProfile("paranoid")).toThrow(
      InvalidPermissionProfileError,
    );
  });

  it("classifies AI chat ask prompts as message sends", () => {
    const policy = evaluateOperationPolicy({
      site: "chatgpt",
      command: "ask",
      args: [{ name: "prompt", required: true }],
      profile: "locked",
    });

    expect(policy).toMatchObject({
      effect: "send_message",
      risk: "high",
      enforcement: "needs_approval",
    });
  });

  it("classifies reviewed manifest mutators by the resource they actually affect", () => {
    const twitterDelete = evaluateOperationPolicy({
      site: "twitter",
      command: "delete",
      description: "Delete your own tweet",
      adapterType: "web-api",
      targetSurface: "web",
      strategy: "cookie",
      profile: "confirm",
    });

    expect(twitterDelete).toMatchObject({
      effect: "destructive",
      risk: "high",
      enforcement: "needs_approval",
      capability_scope: {
        dimensions: {
          network: { access: "write" },
          account: { access: "write" },
          file: { access: "none" },
          process: { access: "none" },
        },
      },
    });

    const listRemove = evaluateOperationPolicy({
      site: "twitter",
      command: "list-remove",
      description: "Remove a Twitter/X user from a list from the browser UI",
      adapterType: "browser",
      targetSurface: "web",
      browser: true,
      profile: "locked",
    });

    expect(listRemove).toMatchObject({
      effect: "account_state",
      risk: "medium",
      enforcement: "needs_approval",
      capability_scope: {
        dimensions: {
          network: { access: "write" },
          browser: { access: "write" },
          account: { access: "write" },
          file: { access: "none" },
          process: { access: "none" },
        },
      },
    });

    const removeBackground = evaluateOperationPolicy({
      site: "yollomi",
      command: "remove-bg",
      description: "Remove background from image (free)",
      adapterType: "web-api",
      targetSurface: "web",
      strategy: "intercept",
      browser: true,
      profile: "locked",
    });

    expect(removeBackground).toMatchObject({
      effect: "remote_transform",
      risk: "medium",
      enforcement: "needs_approval",
      capability_scope: {
        dimensions: {
          network: { access: "write" },
          browser: { access: "write" },
          account: { access: "none" },
          file: { access: "none" },
          process: { access: "none" },
        },
      },
    });

    const wiremockReset = evaluateOperationPolicy({
      site: "wiremock",
      command: "reset",
      description:
        "Reset WireMock server (clear all stubs and request history)",
      adapterType: "service",
      targetSurface: "system",
      strategy: "public",
      profile: "confirm",
    });

    expect(wiremockReset).toMatchObject({
      effect: "service_state",
      risk: "high",
      enforcement: "needs_approval",
      capability_scope: {
        dimensions: {
          network: { access: "write" },
          account: { access: "none" },
          file: { access: "none" },
          process: { access: "none" },
        },
      },
    });
  });

  it("classifies manifest write verbs beyond delete/remove aliases", () => {
    const cases = [
      {
        input: {
          site: "quark",
          command: "rm",
          description: "Delete Quark Drive files or folders by fid list",
          adapterType: "web-api",
          targetSurface: "web" as const,
          strategy: "cookie",
          browser: true,
        },
        expected: {
          effect: "destructive",
          risk: "high",
          dimensions: {
            network: { access: "write" },
            browser: { access: "write" },
            account: { access: "write" },
          },
        },
      },
      {
        input: {
          site: "quark",
          command: "rename",
          description: "Rename a Quark Drive file or folder",
          adapterType: "web-api",
          targetSurface: "web" as const,
          strategy: "cookie",
          browser: true,
        },
        expected: {
          effect: "remote_resource",
          risk: "medium",
          dimensions: {
            network: { access: "write" },
            browser: { access: "write" },
            account: { access: "write" },
          },
        },
      },
      {
        input: {
          site: "wiremock",
          command: "create-stub",
          description: "Create a new stub mapping in WireMock",
          adapterType: "service",
          targetSurface: "system" as const,
          strategy: "public",
        },
        expected: {
          effect: "service_state",
          risk: "high",
          dimensions: {
            network: { access: "write" },
            process: { access: "none" },
            account: { access: "none" },
          },
        },
      },
      {
        input: {
          site: "instagram",
          command: "post",
          description: "Publish a photo post to Instagram",
          adapterType: "web-api",
          targetSurface: "web" as const,
          strategy: "cookie",
          browser: true,
        },
        expected: {
          effect: "publish_content",
          risk: "high",
          dimensions: {
            network: { access: "write" },
            browser: { access: "write" },
            account: { access: "write" },
          },
        },
      },
      {
        input: {
          site: "boss",
          command: "greet",
          description: "Send greeting to a candidate on BOSS Zhipin",
          adapterType: "web-api",
          targetSurface: "web" as const,
          strategy: "intercept",
          browser: true,
        },
        expected: {
          effect: "send_message",
          risk: "high",
          dimensions: {
            network: { access: "write" },
            browser: { access: "write" },
            account: { access: "write" },
          },
        },
      },
      {
        input: {
          site: "boss",
          command: "batchgreet",
          description: "Batch greet recommended candidates on BOSS Zhipin",
          adapterType: "web-api",
          targetSurface: "web" as const,
          strategy: "intercept",
          browser: true,
        },
        expected: {
          effect: "send_message",
          risk: "high",
          dimensions: {
            network: { access: "write" },
            browser: { access: "write" },
            account: { access: "write" },
          },
        },
      },
      {
        input: {
          site: "paperreview",
          command: "feedback",
          description: "Submit a paper draft for AI feedback",
          adapterType: "web-api",
          targetSurface: "web" as const,
          strategy: "public",
          args: [
            { name: "url", required: true },
            { name: "draft", required: true },
          ],
        },
        expected: {
          effect: "remote_transform",
          risk: "medium",
          dimensions: {
            network: { access: "write" },
            account: { access: "none" },
            file: { access: "none" },
            process: { access: "none" },
          },
        },
      },
      {
        input: {
          site: "paperreview",
          command: "review",
          description: "Submit a paper for AI review",
          adapterType: "web-api",
          targetSurface: "web" as const,
          strategy: "public",
        },
        expected: {
          effect: "remote_transform",
          risk: "medium",
          dimensions: {
            network: { access: "write" },
            account: { access: "none" },
          },
        },
      },
      {
        input: {
          site: "paperreview",
          command: "submit",
          description: "Submit a paper to a venue via paperreview.ai",
          adapterType: "web-api",
          targetSurface: "web" as const,
          strategy: "public",
        },
        expected: {
          effect: "publish_content",
          risk: "high",
          dimensions: {
            network: { access: "write" },
            account: { access: "write" },
          },
        },
      },
      {
        input: {
          site: "reddit",
          command: "upvote",
          description: "Upvote a Reddit post or comment",
          adapterType: "web-api",
          targetSurface: "web" as const,
          strategy: "cookie",
        },
        expected: {
          effect: "account_state",
          risk: "medium",
          dimensions: {
            network: { access: "write" },
            account: { access: "write" },
          },
        },
      },
      {
        input: {
          site: "linear",
          command: "issue-create",
          description: "Create a new Linear issue",
          adapterType: "web-api",
          targetSurface: "web" as const,
          strategy: "public",
        },
        expected: {
          effect: "remote_resource",
          risk: "medium",
          dimensions: {
            network: { access: "write" },
            account: { access: "write" },
          },
        },
      },
    ];

    for (const { input, expected } of cases) {
      const policy = evaluateOperationPolicy(input);

      expect(policy, `${input.site}.${input.command}`).toMatchObject({
        effect: expected.effect,
        risk: expected.risk,
        capability_scope: {
          dimensions: expected.dimensions,
        },
      });
    }
  });

  it("classifies optional model switches as local app writes", () => {
    const policy = evaluateOperationPolicy({
      site: "chatgpt",
      command: "model",
      args: [{ name: "name", required: false }],
      profile: "locked",
    });

    expect(policy).toMatchObject({
      effect: "local_app",
      risk: "medium",
      enforcement: "needs_approval",
    });
  });

  it("classifies new conversation commands as local app writes", () => {
    const policy = evaluateOperationPolicy({
      site: "chatgpt",
      command: "new",
      profile: "locked",
    });

    expect(policy).toMatchObject({
      effect: "local_app",
      risk: "medium",
      enforcement: "needs_approval",
    });
  });
});
