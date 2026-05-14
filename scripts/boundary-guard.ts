#!/usr/bin/env tsx
/**
 * @owner   scripts/boundary-guard.ts
 * @does    Enforce the public/private boundary — public repo surface must not
 *          expose paper-private theoretical framing or identity-bridge signals
 *          that leak between the open-source tool and the private academic
 *          workspace under ref/repair-info-paper/.
 * @needs   git ls-files + tracked file contents
 * @feeds   npm run boundary:check, lefthook pre-commit, vitest test mirror
 * @breaks  Public repo surface starts reading as an academic side-project,
 *          or a double-anonymous review fingerprint gets created.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

interface BannedPattern {
  pattern: RegExp;
  category: "paper-vocabulary" | "identity-bridge";
  reason: string;
}

/**
 * Public files must not contain any of these.
 *
 * Each pattern is the smallest specific phrase that uniquely signals
 * paper-private framing — never a common engineering word in isolation
 * ("error" / "envelope" / "agent" / "tool" are public-OK because the OSS
 * community already uses them as idiom — see ref/repair-info-paper/paper/
 * sections/02_background.tex §2.1 for the OSS-idiom-evidence list).
 *
 * Patterns are validated against the current clean state (zero hits on every
 * tracked non-allowlist file at install time). If you add a new pattern that
 * fires on the clean state, the pattern is too broad or the offending file
 * needs to be cleaned up — pick one.
 */
const BANNED: readonly BannedPattern[] = [
  // === paper-vocabulary — formal academic framing names that bridge to the
  // ICSE 2027 submission's §3 motivation and theorem scaffolding ===
  {
    pattern: /\bBanach\b/,
    category: "paper-vocabulary",
    reason:
      "Banach is paper-private §3 scaffolding (replaced by Tarski-Knaster in v0.6); public source should never reference it.",
  },
  {
    pattern: /Rice's restriction|Rice 限制/,
    category: "paper-vocabulary",
    reason:
      "Rice's restriction is academic decidability framing; public docs should describe behaviour in engineering terms.",
  },
  {
    pattern: /Lehman's mandate|Lehman 命令/,
    category: "paper-vocabulary",
    reason: "Lehman's mandate is academic software-evolution framing.",
  },
  {
    pattern: /Hellman[-–—\s]{0,3}Cover/,
    category: "paper-vocabulary",
    reason:
      "Hellman-Cover sequential-Fano is the paper's §3 motivation; private workspace only.",
  },
  {
    pattern: /sequential[\s-]?Fano/i,
    category: "paper-vocabulary",
    reason: "Sequential-Fano bound is paper-private §3 motivation.",
  },
  {
    pattern: /agent[\s-]?tool trilemma|tool trilemma|工具三难/,
    category: "paper-vocabulary",
    reason: "Agent-tool trilemma is paper-private theoretical framing.",
  },
  {
    pattern: /Deterministic Compilation Thesis|"?compilation thesis"?/i,
    category: "paper-vocabulary",
    reason:
      "Deterministic Compilation Thesis was the v0.5 framing that has been archived; public docs should describe Uni-CLI in engineering terms.",
  },
  {
    pattern: /triple[\s-]intersection/,
    category: "paper-vocabulary",
    reason:
      "Triple-intersection moat is paper-private v0.6 §1 anchor sentence.",
  },
  {
    pattern: /envelope[\s-]to[\s-]operator mapping|envelope-IV|envelope as IV/,
    category: "paper-vocabulary",
    reason:
      "Envelope-to-operator mapping / envelope-as-IV is paper-private C2 contribution name.",
  },
  {
    pattern: /H\s*\(\s*fault\s*\|\s*E\s*\)/,
    category: "paper-vocabulary",
    reason: "H(fault|E) is paper-private information bound formula.",
  },
  {
    pattern: /cause[\s-]vs[\s-]fix|cause[\s-]versus[\s-]fix/i,
    category: "paper-vocabulary",
    reason: "Cause-vs-fix is paper-private C4 contribution name.",
  },
  {
    pattern: /\|A\|\s*=\s*5\b|"\|A\| ?= ?5"/,
    category: "paper-vocabulary",
    reason: "|A|=5 is paper-private closed action-mutation set cardinality.",
  },
  {
    pattern: /Cox PH cloglog DTH GLMM/i,
    category: "paper-vocabulary",
    reason:
      "Cox PH cloglog DTH GLMM is paper-private statistical apparatus name.",
  },
  {
    pattern: /\bTheorem [12]\b|\bCorollary \d/,
    category: "paper-vocabulary",
    reason:
      "Numbered theorem / corollary citations belong to the private paper, not the public repo.",
  },
  {
    pattern: /Bounded Adapter Repair: When Do/,
    category: "paper-vocabulary",
    reason:
      "This is the paper's working title; public repo must not reveal it under double-anonymous review.",
  },

  // === identity-bridge — fingerprint signals that bridge between the
  // public repo's author identity and the private academic workspace ===
  {
    pattern: /Author:\s*Claude/i,
    category: "identity-bridge",
    reason:
      "Author signature with model name bridges between human and AI collaboration.",
  },
  {
    pattern: /sonnet[\s-]aligned brainstorm/i,
    category: "identity-bridge",
    reason: "Internal collaboration mode signature.",
  },
  // NOTE: `.claude/plans/sessions/` path references are intentionally NOT a
  // banned pattern. Active scan in the current tree found four legitimate
  // engineering-provenance citations of design-doc paths in source-code
  // header comments (bench/agent/ics.ts, src/engine/args.ts,
  // src/transport/capability.ts, .claude/commands/phase-review.md). Pointing
  // to internal design docs is engineering hygiene, not a paper identity
  // bridge. The actual bridges are author signatures + memory-entry quotes
  // (caught below), not path references.
  //
  // Same reasoning: `memory: <name>.md` body lines are too easy to false-
  // positive on legitimate engineering text. The signal we want is the
  // narrow combination of memory entries quoted in a way that reveals the
  // paper-side workspace; that combination is currently caught by the
  // `docs/superpowers/` and `tool-surface-audit-` patterns instead.
  {
    pattern: /tool-surface-audit-\d{4}/,
    category: "identity-bridge",
    reason: "Internal audit identifier.",
  },
  {
    pattern: /docs\/superpowers\//,
    category: "identity-bridge",
    reason:
      "docs/superpowers/ was an internal-design-doc subtree that has been archived.",
  },
  {
    pattern: /internal\/refs\.bib/,
    category: "identity-bridge",
    reason:
      "internal/refs.bib was the academic-references file that has been archived.",
  },
] as const;

/**
 * Paths that are legitimately allowed to contain these strings — frozen
 * historical record, archived content, generated build artefacts, or this
 * tool itself.
 */
const ALLOWLIST: readonly RegExp[] = [
  /^ref\//,
  /^archive\//,
  /^node_modules\//,
  /^dist\//,
  /\.vitepress\/dist\//,
  /^docs\/public\//, // generated agent-assets — boundary-checked at source
  /^CHANGELOG\.md$/, // frozen historical record
  /^scripts\/boundary-guard\.ts$/, // this file
  /^tests\/unit\/public-private-boundary\.test\.ts$/, // mirror test file
  /^AGENTS\.md$/, // doctrine spec — enumerates the banned patterns by name
  /^package-lock\.json$/, // transitive dep names not under our control
  /^\.git\//,
  // NOTE: CLAUDE.md is local-only via repo `.gitignore`; `git ls-files` does
  // not include it, so no explicit allowlist entry is needed. If a future
  // change makes CLAUDE.md tracked, add it here with the same justification
  // as AGENTS.md (doctrine spec).
] as const;

const TEXT_EXTENSIONS =
  /\.(md|mdx|ts|tsx|js|jsx|json|yml|yaml|toml|sh|py|tex|bib|txt|html|css)$/i;

interface Violation {
  file: string;
  line: number;
  match: string;
  category: BannedPattern["category"];
  reason: string;
}

function listTrackedFiles(): string[] {
  return execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowlisted(file: string): boolean {
  return ALLOWLIST.some((rx) => rx.test(file));
}

function scanFile(file: string): Violation[] {
  const path = join(ROOT, file);
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const violations: Violation[] = [];
  for (const { pattern, category, reason } of BANNED) {
    const rx = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
    );
    let m: RegExpExecArray | null;
    while ((m = rx.exec(content))) {
      const line = content.slice(0, m.index).split("\n").length;
      violations.push({ file, line, match: m[0], category, reason });
      if (m[0].length === 0) rx.lastIndex++; // safety against zero-width
    }
  }
  return violations;
}

export function scanRepo(): Violation[] {
  const files = listTrackedFiles().filter(
    (f) => !isAllowlisted(f) && TEXT_EXTENSIONS.test(f),
  );
  return files.flatMap(scanFile);
}

function main(): void {
  const violations = scanRepo();
  if (violations.length === 0) {
    console.log(
      `boundary-guard: PASS — scanned ${listTrackedFiles().filter((f) => !isAllowlisted(f) && TEXT_EXTENSIONS.test(f)).length} files against ${BANNED.length} patterns`,
    );
    return;
  }
  for (const v of violations) {
    console.error(
      `${v.file}:${v.line}: [${v.category}] "${v.match}" — ${v.reason}`,
    );
  }
  console.error(
    `\nboundary-guard: ${violations.length} violation(s) across ${new Set(violations.map((v) => v.file)).size} file(s).`,
  );
  console.error(
    "Public repo surface must not expose paper-private theoretical framing or identity-bridge signals.",
  );
  console.error(
    "If this is legitimate, either (a) move the file under ref/ or archive/, or (b) rewrite using engineering vocabulary.",
  );
  process.exit(1);
}

// Run when invoked as a script (not when imported by the test mirror)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
