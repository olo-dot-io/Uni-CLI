import { onContentUpdated } from "vitepress";
import {
  layout,
  measureLineStats,
  prepare,
  prepareWithSegments,
  type PreparedText,
  type PreparedTextWithSegments,
} from "@chenglou/pretext";

type PreparedEntry = {
  signature: string;
  prepared: PreparedText;
  segmented: PreparedTextWithSegments;
};

const typographySelector = [
  ".VPHero .text",
  ".VPHero .tagline",
  ".VPFeature .title",
  ".VPFeature .details",
  ".uni-home-stats h2",
  ".uni-home-stats p:not(.uni-eyebrow)",
  ".uni-surface small",
  ".vp-doc h1",
  ".vp-doc h2",
  ".vp-doc h3",
  ".vp-doc p",
  ".vp-doc li",
  ".site-card h3",
  ".site-card-top p",
  ".site-command-list span",
  ".agent-breadcrumbs [aria-current='page']",
].join(",");

const balanceSelector = [
  ".VPHero .text",
  ".VPHero .tagline",
  ".uni-home-stats h2",
  ".vp-doc h1",
  ".vp-doc h2",
].join(",");

const stabilizeSelector = [
  ".site-command-list span",
  ".VPFeature .details",
].join(",");

const preparedCache = new WeakMap<Element, PreparedEntry>();
let mutationObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let scheduled = false;

function numericPixel(value: string, fallback = 0): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cssFont(style: CSSStyleDeclaration): string {
  const fontStyle = style.fontStyle === "normal" ? "" : style.fontStyle;
  const fontVariant = style.fontVariant === "normal" ? "" : style.fontVariant;
  return [
    fontStyle,
    fontVariant,
    style.fontWeight,
    style.fontSize,
    style.fontFamily,
  ]
    .filter(Boolean)
    .join(" ");
}

function lineHeight(style: CSSStyleDeclaration): number {
  if (style.lineHeight === "normal") {
    return numericPixel(style.fontSize, 16) * 1.45;
  }

  return numericPixel(
    style.lineHeight,
    numericPixel(style.fontSize, 16) * 1.45,
  );
}

function whiteSpaceMode(style: CSSStyleDeclaration): "normal" | "pre-wrap" {
  return style.whiteSpace === "pre-wrap" || style.whiteSpace === "break-spaces"
    ? "pre-wrap"
    : "normal";
}

function textForMeasurement(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function preparedFor(
  element: Element,
  text: string,
  font: string,
  style: CSSStyleDeclaration,
): PreparedEntry {
  const letterSpacing = numericPixel(style.letterSpacing, 0);
  const wordBreak = style.wordBreak === "keep-all" ? "keep-all" : "normal";
  const whiteSpace = whiteSpaceMode(style);
  const signature = JSON.stringify({
    text,
    font,
    letterSpacing,
    whiteSpace,
    wordBreak,
  });
  const cached = preparedCache.get(element);

  if (cached?.signature === signature) {
    return cached;
  }

  const options = { letterSpacing, whiteSpace, wordBreak } as const;
  const entry = {
    signature,
    prepared: prepare(text, font, options),
    segmented: prepareWithSegments(text, font, options),
  };
  preparedCache.set(element, entry);
  return entry;
}

function balancedWidth(
  prepared: PreparedTextWithSegments,
  maxWidth: number,
): number | null {
  if (maxWidth < 320) {
    return null;
  }

  const base = measureLineStats(prepared, maxWidth);
  if (base.lineCount < 2) {
    return null;
  }

  const minWidth = Math.max(220, Math.floor(maxWidth * 0.58));
  let bestWidth = maxWidth;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let width = maxWidth; width >= minWidth; width -= 8) {
    const stats = measureLineStats(prepared, width);
    if (stats.lineCount !== base.lineCount) {
      continue;
    }

    const raggedEdge = Math.max(0, width - stats.maxLineWidth);
    const opticalWidth = Math.abs(width - maxWidth * 0.88);
    const score = raggedEdge + opticalWidth * 0.18;
    if (score < bestScore) {
      bestScore = score;
      bestWidth = width;
    }
  }

  return bestWidth < maxWidth - 12 ? bestWidth : null;
}

function measureElement(element: Element): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }

  const text = textForMeasurement(element);
  if (!text) {
    return;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 12 || rect.height === 0) {
    return;
  }

  const style = getComputedStyle(element);
  const font = cssFont(style);
  const entry = preparedFor(element, text, font, style);
  const maxWidth = Math.floor(rect.width);
  const lineHeightPx = lineHeight(style);
  const result = layout(entry.prepared, maxWidth, lineHeightPx);

  element.classList.add("pretext-measured");
  element.style.setProperty("--pretext-lines", String(result.lineCount));
  element.style.setProperty(
    "--pretext-height",
    `${Math.ceil(result.height)}px`,
  );
  element.dataset.pretextLines = String(result.lineCount);

  if (element.matches(balanceSelector)) {
    const width = balancedWidth(entry.segmented, maxWidth);
    if (width) {
      element.classList.add("pretext-balanced");
      element.style.setProperty("--pretext-balance-width", `${width}px`);
    } else {
      element.classList.remove("pretext-balanced");
      element.style.removeProperty("--pretext-balance-width");
    }
  }

  if (element.matches(stabilizeSelector) && result.lineCount > 1) {
    element.classList.add("pretext-stabilized");
  } else {
    element.classList.remove("pretext-stabilized");
  }
}

function clearPretextState(element: Element): void {
  element.classList.remove(
    "pretext-measured",
    "pretext-balanced",
    "pretext-stabilized",
  );

  if (element instanceof HTMLElement) {
    element.style.removeProperty("--pretext-lines");
    element.style.removeProperty("--pretext-height");
    element.style.removeProperty("--pretext-balance-width");
    delete element.dataset.pretextLines;
  }
}

function runPretextPass(): void {
  scheduled = false;
  document.documentElement.classList.add("pretext-typography");

  for (const element of document.querySelectorAll(typographySelector)) {
    try {
      measureElement(element);
    } catch {
      clearPretextState(element);
    }
  }
}

function schedulePretextPass(): void {
  if (scheduled) {
    return;
  }

  scheduled = true;
  window.requestAnimationFrame(runPretextPass);
}

function canMeasureText(): boolean {
  return (
    typeof window !== "undefined" &&
    "Segmenter" in Intl &&
    (typeof OffscreenCanvas !== "undefined" ||
      typeof document.createElement("canvas").getContext === "function")
  );
}

export function installPretextTypography(): void {
  if (!canMeasureText()) {
    return;
  }

  onContentUpdated(schedulePretextPass);
  window.addEventListener("resize", schedulePretextPass, { passive: true });

  mutationObserver?.disconnect();
  mutationObserver = new MutationObserver(schedulePretextPass);
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(schedulePretextPass);
  resizeObserver.observe(document.documentElement);

  if (document.fonts) {
    void document.fonts.ready.then(schedulePretextPass);
  }

  schedulePretextPass();
}
