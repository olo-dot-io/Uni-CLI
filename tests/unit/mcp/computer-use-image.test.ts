import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { err, exitCodeFor, ok } from "../../../src/core/envelope.js";
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
const CHANGED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("computer-use MCP image content", () => {
  const previousPermissionProfile = process.env.UNICLI_PERMISSION_PROFILE;
  let visual: VisualCoordinateFixtureTransport;

  beforeEach(() => {
    process.env.UNICLI_PERMISSION_PROFILE = "open";
    _resetTransportBusForTests();
    getBus().register(new ScreenshotFixtureTransport());
    visual = new VisualCoordinateFixtureTransport();
    getBus().register(visual);
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
      params: {
        name: "computer-use.screenshot",
        arguments: { via: "browser" },
      },
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
    expect(result.structuredContent.data).toMatchObject({
      effect_verdict: {
        status: "not_applicable",
        evidence: "declared_read",
      },
    });
    expect(result._meta?.["anthropic/maxResultSizeChars"]).toBeUndefined();
  });

  it("separates host file writes into the task-required screenshot_file tool", async () => {
    const handler = buildHandler(selectTools("computer-use"));
    const response = await handler({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "computer-use.screenshot_file",
        arguments: { path: "/tmp/frame.png", via: "browser" },
      },
    });

    expect(response?.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("requires task augmentation"),
    });
  });

  it("preserves native image content through a durable capture task", async () => {
    const handler = buildHandler(selectTools("computer-use"));
    const created = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "computer-use.capture",
        arguments: { include: "screenshot", via: "browser" },
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

  it("returns the next same-provider frame for an ordinary coordinate action without duplicating image bytes", async () => {
    visual.frames = [PNG_BASE64, CHANGED_PNG_BASE64];
    const result = await runPointClick();

    expect(visual.calls).toEqual([
      "visual_snapshot",
      "visual_click",
      "visual_snapshot",
    ]);
    expect(result.content[0]).toEqual({
      type: "image",
      data: CHANGED_PNG_BASE64,
      mimeType: "image/png",
    });
    expect(result.structuredContent.data).toMatchObject({
      post_action_capture: {
        ok: true,
        transport: "visual",
        image: {
          mime_type: "image/png",
          bytes: Buffer.from(CHANGED_PNG_BASE64, "base64").length,
          sha256: sha256(CHANGED_PNG_BASE64),
          width: 1,
          height: 1,
        },
        encoded_frame_change: {
          status: "changed",
          method: "sha256-encoded-image",
          before_sha256: sha256(PNG_BASE64),
          after_sha256: sha256(CHANGED_PNG_BASE64),
        },
        data: {
          observation: {
            provider: "visual",
            ref: expect.stringMatching(/^visual-observation:[a-f0-9]{64}$/),
          },
        },
      },
    });
    const metadata = JSON.stringify({
      structuredContent: result.structuredContent,
      meta: result._meta,
      text: result.content.slice(1),
    });
    expect(metadata).not.toContain(CHANGED_PNG_BASE64);
    expect(JSON.stringify(result).split(CHANGED_PNG_BASE64)).toHaveLength(2);
    const duplicatedResponseBytes =
      Buffer.byteLength(metadata) + 2 * Buffer.byteLength(CHANGED_PNG_BASE64);
    expect(duplicatedResponseBytes - Buffer.byteLength(metadata)).toBe(
      2 * Buffer.byteLength(CHANGED_PNG_BASE64),
    );
  });

  it("reports an exact unchanged-frame observation without claiming action success", async () => {
    visual.frames = [PNG_BASE64, PNG_BASE64];
    const result = await runPointClick();

    expect(result.structuredContent.data).toMatchObject({
      effect_verdict: {
        status: "unverifiable",
        evidence: "dispatch_receipt",
      },
      post_action_capture: {
        ok: true,
        encoded_frame_change: {
          status: "unchanged",
          before_sha256: sha256(PNG_BASE64),
          after_sha256: sha256(PNG_BASE64),
        },
      },
    });
  });

  it("keeps a settled action result and exposes a typed same-provider capture failure", async () => {
    visual.failPostCapture = true;
    const result = await runPointClick();

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.structuredContent.data).toMatchObject({
      effect_verdict: {
        status: "unverifiable",
        evidence: "dispatch_receipt",
      },
      post_action_capture: {
        ok: false,
        transport: "visual",
        error: {
          reason: "fixture post-action capture unavailable",
          minimum_capability: "visual.visual_snapshot",
          exit_code: exitCodeFor("service_unavailable"),
        },
      },
    });
    expect(visual.calls).toEqual([
      "visual_snapshot",
      "visual_click",
      "visual_snapshot",
    ]);
  });
});

async function runPointClick(): Promise<{
  content: Array<Record<string, unknown>>;
  structuredContent: { data: Record<string, unknown> };
  _meta?: Record<string, unknown>;
  isError?: boolean;
}> {
  const handler = buildHandler(selectTools("computer-use"));
  const observed = await handler({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "computer-use.screenshot",
      arguments: { via: "visual" },
    },
  });
  if (!observed) throw new Error("coordinate observation returned no result");
  const observation = (
    observed.result as {
      structuredContent: { data: { observation: { ref: string } } };
    }
  ).structuredContent.data.observation.ref;
  const created = await handler({
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: {
      name: "computer-use.point_click",
      arguments: { x: 0, y: 0, observation, via: "visual" },
      task: {},
    },
  });
  if (!created) throw new Error("coordinate action returned no task");
  const taskId = (created.result as { task: { taskId: string } }).task.taskId;
  const completed = await handler({
    jsonrpc: "2.0",
    id: 22,
    method: "tasks/result",
    params: { taskId },
  });
  return completed?.result as {
    content: Array<Record<string, unknown>>;
    structuredContent: { data: Record<string, unknown> };
    _meta?: Record<string, unknown>;
    isError?: boolean;
  };
}

function sha256(base64: string): string {
  return createHash("sha256")
    .update(Buffer.from(base64, "base64"))
    .digest("hex");
}

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

class VisualCoordinateFixtureTransport implements TransportAdapter {
  readonly kind = "visual" as const;
  readonly capability = {
    steps: ["visual_snapshot", "visual_click"] as const,
    snapshotFormats: ["screenshot"] as const,
    mutatesHost: true,
  };
  readonly calls: string[] = [];
  frames = [PNG_BASE64, CHANGED_PNG_BASE64];
  failPostCapture = false;
  private snapshots = 0;

  async open(_context: TransportContext): Promise<void> {}

  async action<T = unknown>(request: ActionRequest): Promise<ActionResult<T>> {
    this.calls.push(request.kind);
    if (request.kind === "visual_click") {
      return ok({ transport: "visual", clicked: true } as unknown as T);
    }
    if (request.kind === "visual_snapshot") {
      if (this.failPostCapture && this.snapshots > 0) {
        return err({
          transport: "visual",
          step: 0,
          action: request.kind,
          reason: "fixture post-action capture unavailable",
          suggestion: "repair the selected visual provider",
          minimum_capability: "visual.visual_snapshot",
          exit_code: exitCodeFor("service_unavailable"),
        });
      }
      const frame =
        this.frames[Math.min(this.snapshots, this.frames.length - 1)]!;
      this.snapshots += 1;
      return ok({
        transport: "visual",
        base64: frame,
        mime: "image/png",
        width: 1,
        height: 1,
      } as unknown as T);
    }
    throw new Error(`unexpected visual fixture action ${request.kind}`);
  }

  async snapshot(): Promise<never> {
    throw new Error("snapshot is outside this visual fixture");
  }

  async close(): Promise<void> {}
}
