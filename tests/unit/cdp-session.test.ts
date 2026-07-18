import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CdpSessionStateError,
  loadCdpSession,
  saveCdpSession,
} from "../../src/transport/cdp-session.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporarySessionPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "unicli-cdp-session-"));
  temporaryDirectories.push(directory);
  return join(directory, "cdp-session.json");
}

describe("CDP session persistence", () => {
  it("publishes private immutable records and loads the latest exact renderer", () => {
    const path = temporarySessionPath();
    vi.spyOn(Date, "now").mockReturnValue(1234);

    saveCdpSession(
      {
        app: "vscode",
        port: 9240,
        targetId: "renderer-a",
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/devtools/page/a",
      },
      path,
    );
    saveCdpSession(
      {
        app: "vscode",
        port: 9240,
        targetId: "renderer-b",
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/devtools/page/b",
      },
      path,
    );

    expect(loadCdpSession(path)).toMatchObject({
      targetId: "renderer-b",
      webSocketDebuggerUrl: "ws://127.0.0.1:9240/devtools/page/b",
    });
    const records = readdirSync(`${path}.d`).filter((name) =>
      name.endsWith(".json"),
    );
    expect(records).toHaveLength(2);
    expect(statSync(`${path}.d`).mode & 0o777).toBe(0o700);
    for (const record of records) {
      expect(statSync(join(`${path}.d`, record)).mode & 0o777).toBe(0o600);
    }
  });

  it("ignores unpublished staging files but fails closed on a corrupt record", () => {
    const path = temporarySessionPath();
    saveCdpSession(
      {
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/live",
      },
      path,
    );
    writeFileSync(join(`${path}.d`, ".interrupted.tmp"), "{");
    expect(loadCdpSession(path)?.port).toBe(9333);

    writeFileSync(join(`${path}.d`, "9999999999999999.corrupt.json"), "{");
    expect(() => loadCdpSession(path)).toThrow(CdpSessionStateError);
  });

  it("reads a valid legacy aggregate without rewriting it", () => {
    const path = temporarySessionPath();
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        port: 9444,
        webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/legacy",
        savedAt: 456,
      }),
    );

    expect(loadCdpSession(path)).toMatchObject({ port: 9444, savedAt: 456 });
  });

  it("rejects corrupt legacy state with the typed repair boundary", () => {
    const path = temporarySessionPath();
    writeFileSync(path, "not-json");

    expect(() => loadCdpSession(path)).toThrow(CdpSessionStateError);
  });
});
