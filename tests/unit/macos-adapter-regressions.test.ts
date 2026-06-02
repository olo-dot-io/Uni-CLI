import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

interface AdapterShape {
  columns?: string[];
}

function readMacosAdapter(command: string): string {
  return readFileSync(
    join(ROOT, "src", "adapters", "macos", `${command}.yaml`),
    "utf-8",
  );
}

function parseMacosAdapter(command: string): AdapterShape {
  return yaml.load(readMacosAdapter(command)) as AdapterShape;
}

describe("macOS adapter real-run regressions", () => {
  it("keeps brightness observable when no AppleBacklightDisplay node exists", () => {
    const raw = readMacosAdapter("brightness");
    const adapter = parseMacosAdapter("brightness");

    expect(raw).toContain(
      "ioreg -r -c AppleBacklightDisplay -k brightness 2>/dev/null || true",
    );
    expect(raw).toContain("status: percent === null ? 'unavailable' : 'ok'");
    expect(adapter.columns).toEqual(["brightness", "status"]);
  });

  it("uses bounded Calendar startDate predicates without duplicate object keys", () => {
    const today = readMacosAdapter("calendar-today");
    const list = readMacosAdapter("calendar-list");

    expect(today).not.toContain("startDate: {_greaterThan: start}, startDate:");
    expect(today).toContain("startDate: {_greaterThan: start, _lessThan: end}");
    expect(list).toContain("startDate: {_greaterThan: now, _lessThan: end}");
  });

  it("returns an explicit Safari no-window state instead of indexing window zero", () => {
    const raw = readMacosAdapter("safari-url");
    const adapter = parseMacosAdapter("safari-url");

    expect(raw).toContain("windows.length === 0");
    expect(raw).toContain("state: 'no_window'");
    expect(adapter.columns).toEqual(["state", "url", "title"]);
  });
});
