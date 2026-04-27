#!/usr/bin/env tsx
/**
 * Guardrails for the public docs surface.
 *
 * The root public site is English, while localized docs live under explicit
 * locale paths. This scans generated agent assets plus the VitePress output
 * that GitHub Pages deploys.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const publicTextRoots = [
  "docs/site-index.json",
  "docs/public",
  "docs/.vitepress/dist",
];
const textExtensions = new Set([
  ".html",
  ".json",
  ".md",
  ".txt",
  ".webmanifest",
]);
const ignoredPathFragments = [
  "/docs/.vitepress/dist/assets/style",
  "/docs/.vitepress/dist/assets/inter-",
  "/docs/.vitepress/dist/vp-icons.css",
];
const cjkPattern =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const bannedPatterns = [/\bper-call\b/iu, /internal source maps?/iu];
const allowedGlobalCjkFragments = ["简体中文"];

type Finding = {
  file: string;
  line: number;
  reason: string;
  text: string;
};

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function shouldScan(filePath: string): boolean {
  const normalized = `/${toPosix(relative(process.cwd(), filePath))}`;

  if (ignoredPathFragments.some((fragment) => normalized.includes(fragment))) {
    return false;
  }

  return textExtensions.has(extname(filePath));
}

function allowsLocalizedCjk(filePath: string): boolean {
  const normalized = `/${toPosix(relative(process.cwd(), filePath))}`;
  return (
    normalized.includes("/docs/.vitepress/dist/markdown/zh/") ||
    normalized.includes("/docs/.vitepress/dist/zh/") ||
    normalized.includes("/docs/public/markdown/zh/") ||
    normalized.includes("/docs/public/zh/")
  );
}

function stripAllowedGlobalCjk(line: string): string {
  return allowedGlobalCjkFragments.reduce(
    (current, fragment) => current.replaceAll(fragment, ""),
    line,
  );
}

function preserveLineBreaks(text: string): string {
  return text.match(/\r\n|\r|\n/gu)?.join("") ?? "";
}

function textForScan(filePath: string, text: string): string {
  if (extname(filePath) !== ".html") {
    return text;
  }

  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, preserveLineBreaks)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, preserveLineBreaks);
}

function collectFiles(target: string, files: string[] = []): string[] {
  const fullPath = resolve(target);
  if (!existsSync(fullPath)) {
    return files;
  }

  const stat = statSync(fullPath);
  if (stat.isFile()) {
    if (shouldScan(fullPath)) {
      files.push(fullPath);
    }
    return files;
  }

  for (const entry of readdirSync(fullPath)) {
    collectFiles(join(fullPath, entry), files);
  }

  return files;
}

function scanFile(filePath: string): Finding[] {
  const text = textForScan(filePath, readFileSync(filePath, "utf-8"));
  const lines = text.split(/\r?\n/);
  const findings: Finding[] = [];

  lines.forEach((lineText, index) => {
    if (
      !allowsLocalizedCjk(filePath) &&
      cjkPattern.test(stripAllowedGlobalCjk(lineText))
    ) {
      findings.push({
        file: toPosix(relative(process.cwd(), filePath)),
        line: index + 1,
        reason: "CJK text is not allowed on the public English docs surface",
        text: lineText.trim(),
      });
    }

    for (const pattern of bannedPatterns) {
      if (pattern.test(lineText)) {
        findings.push({
          file: toPosix(relative(process.cwd(), filePath)),
          line: index + 1,
          reason: `Banned stale public phrase: ${pattern.source}`,
          text: lineText.trim(),
        });
      }
    }
  });

  return findings;
}

function main(): void {
  const files = publicTextRoots.flatMap((target) => collectFiles(target));
  const findings = files.flatMap(scanFile);

  if (findings.length > 0) {
    process.stderr.write("Public docs check failed:\n");
    for (const finding of findings.slice(0, 50)) {
      process.stderr.write(
        `- ${finding.file}:${finding.line} ${finding.reason}\n  ${finding.text}\n`,
      );
    }
    if (findings.length > 50) {
      process.stderr.write(`...and ${findings.length - 50} more findings.\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`public docs check passed: ${files.length} files\n`);
}

main();
