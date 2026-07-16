import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ok } from "../../../src/core/envelope.js";
import { buildHandler } from "../../../src/mcp/handler.js";
import { selectTools } from "../../../src/mcp/tools.js";
import {
  _resetTransportBusForTests,
  getBus,
} from "../../../src/transport/bus.js";
import type {
  ActionRequest,
  ActionResult,
  TransportAdapter,
  TransportContext,
} from "../../../src/transport/types.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

describe("computer-use MCP image content", () => {
  const previousPermissionProfile = process.env.UNICLI_PERMISSION_PROFILE;

  beforeEach(() => {
    process.env.UNICLI_PERMISSION_PROFILE = "open";
    _resetTransportBusForTests();
    getBus().register(new ScreenshotFixtureTransport());
  });

  afterEach(() => {
    _resetTransportBusForTests();
    if (previousPermissionProfile === undefined) {
      delete process.env.UNICLI_PERMISSION_PROFILE;
    } else {
      process.env.UNICLI_PERMISSION_PROFILE = previousPermissionProfile;
    }
  });

  it("returns screenshot bytes as native ImageContent without base64 text duplication", async () => {
    const handler = buildHandler(selectTools("computer-use"));
    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "computer-use.screenshot", arguments: {} },
    });
    const result = response?.result as {
      content: Array<Record<string, unknown>>;
      structuredContent: { data: unknown };
      _meta?: Record<string, unknown>;
    };

    expect(result.content[0]).toEqual({
      type: "image",
      data: PNG_BASE64,
      mimeType: "image/png",
    });
    expect(
      Buffer.from(result.content[0]!.data as string, "base64")
        .subarray(1, 4)
        .toString("ascii"),
    ).toBe("PNG");
    expect(result.content[1]).toMatchObject({ type: "text" });
    expect(result.content[1]!.text as string).not.toContain(PNG_BASE64);
    expect(JSON.stringify(result.structuredContent.data)).not.toContain(
      PNG_BASE64,
    );
    expect(result._meta?.["anthropic/maxResultSizeChars"]).toBeUndefined();
  });

  it("preserves native image content through a durable capture task", async () => {
    const handler = buildHandler(selectTools("computer-use"));
    const created = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "computer-use.capture",
        arguments: { include: "screenshot" },
        task: {},
      },
    });
    if (!created) throw new Error("capture task returned no response");
    const taskId = (created.result as { task: { taskId: string } }).task.taskId;
    const completed = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tasks/result",
      params: { taskId },
    });
    const result = completed?.result as {
      content: Array<Record<string, unknown>>;
      structuredContent: { data: unknown };
    };

    expect(result.content[0]).toEqual({
      type: "image",
      data: PNG_BASE64,
      mimeType: "image/png",
    });
    expect(JSON.stringify(result.content.slice(1))).not.toContain(PNG_BASE64);
    expect(JSON.stringify(result.structuredContent.data)).not.toContain(
      PNG_BASE64,
    );
  });
});

class ScreenshotFixtureTransport implements TransportAdapter {
  readonly kind = "cdp-browser" as const;
  readonly capability = {
    steps: ["screenshot"] as const,
    snapshotFormats: ["screenshot"] as const,
    mutatesHost: false,
  };

  async open(_context: TransportContext): Promise<void> {}

  async action<T = unknown>(_request: ActionRequest): Promise<ActionResult<T>> {
    return ok(Buffer.from(PNG_BASE64, "base64") as unknown as T);
  }

  async snapshot(): Promise<never> {
    throw new Error("snapshot is outside this screenshot fixture");
  }

  async close(): Promise<void> {}
}
