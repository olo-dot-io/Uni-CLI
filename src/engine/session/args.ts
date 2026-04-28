import { createHash } from "node:crypto";

export function stableRunJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableRunJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableRunJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function hashRunArgs(args: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableRunJson(args)).digest("hex")}`;
}
