import { vi } from "vitest";

import type { IPage } from "../../../src/types.js";

export function browserPageReturning<T>(value: T): IPage {
  return {
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => value),
  } as unknown as IPage;
}

export function failingBrowserPage(message: string): IPage {
  return {
    goto: vi.fn(async () => {
      throw new Error(message);
    }),
    evaluate: vi.fn(),
  } as unknown as IPage;
}
