import { describe, expect, it } from "vitest";
import { Command } from "commander";

import {
  buildSocialCommentArgs,
  registerSocialCommand,
  selectCommentCommand,
} from "../../../src/commands/social.js";
import { registerAdapter } from "../../../src/registry.js";
import { AdapterType } from "../../../src/types.js";
import { validateEnvelope } from "../../../src/output/envelope.js";
import {
  compileAll,
  _resetCompiledCacheForTests,
} from "../../../src/engine/invoke.js";

function captureStdout(): {
  getStdout: () => string;
  restore: () => void;
} {
  let out = "";
  const origLog = console.log;
  console.log = ((...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  return {
    getStdout: () => out,
    restore: () => {
      console.log = origLog;
    },
  };
}

function captureStderr(): {
  getStderr: () => string;
  restore: () => void;
} {
  let err = "";
  const origError = console.error;
  console.error = ((...args: unknown[]) => {
    err += args.map(String).join(" ") + "\n";
  }) as typeof console.error;
  return {
    getStderr: () => err,
    restore: () => {
      console.error = origError;
    },
  };
}

describe("unicli social coverage", () => {
  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerSocialCommand(program);
    return program;
  }

  it("emits filtered social capability coverage", async () => {
    registerAdapter({
      name: "unit-social-video",
      type: AdapterType.WEB_API,
      commands: {
        comments: {
          name: "comments",
          description: "Read comments with replies",
          columns: ["author", "text", "replies"],
        },
        subtitles: {
          name: "subtitles",
          description: "Extract video subtitles",
        },
      },
    });

    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(
        [
          "-f",
          "json",
          "social",
          "coverage",
          "--site",
          "unit-social-video",
          "--capability",
          "subtitles",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("social.coverage");
    expect(env.data).toEqual([
      expect.objectContaining({
        site: "unit-social-video",
        commands: 2,
        capabilities: expect.arrayContaining(["comments", "subtitles"]),
      }),
    ]);
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("selects readable comment commands instead of write-only comment commands", () => {
    const commandName = selectCommentCommand({
      name: "unit-social-read-comments",
      type: AdapterType.WEB_API,
      commands: {
        comment: {
          name: "comment",
          adapterArgs: [
            { name: "thing-id", type: "str", required: true },
            { name: "text", type: "str", required: true },
          ],
        },
        comments: {
          name: "comments",
          adapterArgs: [{ name: "url", type: "str", required: true }],
        },
      },
    });

    expect(commandName).toBe("comments");
  });

  it("maps normalized social comment args for platform-specific targets", () => {
    expect(
      buildSocialCommentArgs(
        "zhihu",
        {
          name: "comment",
          adapterArgs: [
            { name: "type", type: "str" },
            { name: "id", type: "str" },
            { name: "limit", type: "int" },
            { name: "with-replies", type: "bool" },
          ],
        },
        "answer:306113036",
        { limit: "3", withReplies: true },
      ),
    ).toEqual({
      type: "answer",
      id: "306113036",
      limit: 3,
      "with-replies": true,
    });
  });

  it("maps Twitter thread targets into tweet_id for normalized comments", () => {
    expect(
      buildSocialCommentArgs(
        "twitter",
        {
          name: "thread",
          socialCapabilities: ["read", "comments", "comment_replies"],
          adapterArgs: [{ name: "tweet_id", type: "str", required: true }],
        },
        "1850000000000000000",
        {},
      ),
    ).toEqual({ tweet_id: "1850000000000000000" });
  });

  it("rejects invalid social capability filters instead of returning empty success", async () => {
    const cap = captureStderr();
    process.exitCode = undefined;
    try {
      const program = newProgram();
      await program.parseAsync(
        ["-f", "json", "social", "coverage", "--capability", "not-a-cap"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(process.exitCode).toBe(2);
    expect(env.ok).toBe(false);
    expect(env.error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("Invalid social capability"),
    });
    process.exitCode = undefined;
  });

  it("treats an empty normalized comment result as a successful social response", async () => {
    const adapter = {
      name: "unit-empty-comments",
      type: AdapterType.WEB_API,
      commands: {
        comments: {
          name: "comments",
          adapterArgs: [{ name: "url", type: "str" as const }],
          columns: ["platform", "content_id", "comment_id", "text"],
          func: async () => [],
        },
      },
    };
    _resetCompiledCacheForTests();
    registerAdapter(adapter);
    compileAll([adapter]);

    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(
        [
          "-f",
          "json",
          "social",
          "comments",
          "unit-empty-comments",
          "https://example.com/post/1",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("social.comments");
    expect(env.data).toEqual([]);
  });
});
