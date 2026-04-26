import type { IPage } from "../../types.js";

export function str(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function intArg(value: unknown, fallback: number, max = 100): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

export function boolArg(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

export function js(value: unknown): string {
  return JSON.stringify(value);
}

export async function gotoSettled(
  page: IPage,
  url: string,
  settleMs = 1600,
): Promise<void> {
  await page.goto(url, { settleMs });
}

export async function readDomItems<T>(
  page: IPage,
  url: string,
  script: string,
  settleMs = 1600,
): Promise<T[]> {
  await gotoSettled(page, url, settleMs);
  const value = await page.evaluate(script);
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function clickFirst(
  page: IPage,
  selectors: readonly string[],
): Promise<string | null> {
  for (const selector of selectors) {
    try {
      await page.click(selector);
      return selector;
    } catch {
      // Try the next stable selector.
    }
  }
  return null;
}

export async function visibleText(page: IPage): Promise<string> {
  const text = await page.evaluate("document.body?.innerText ?? ''");
  return str(text).trim();
}
