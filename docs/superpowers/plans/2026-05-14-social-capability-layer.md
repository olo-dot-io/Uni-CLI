# Social Capability Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build reusable social-media capability contracts for command discovery, hierarchical comments, and video subtitle extraction across every registered site, then attach richer behavior to the named social platforms.

**Architecture:** Add a focused `src/social/` layer with pure normalizers and capability inference, expose it through `unicli social coverage`, and use it from high-value adapters without replacing the adapter runner. Video subtitles use `yt-dlp` as the primary extractor with browser-cookie reuse through `--cookies-from-browser` when requested.

**Tech Stack:** TypeScript, Vitest, existing adapter registry, existing Chromium cookie detection, existing `yt-dlp` subprocess integration.

---

### Task 1: Social Capability Metadata

**Files:**

- Create: `src/social/capabilities.ts`
- Modify: `src/types.ts`
- Modify: `src/registry.ts`
- Test: `tests/unit/social/capabilities.test.ts`

- [ ] Add typed social capability names such as `read`, `search`, `trends`, `comments`, `comment_replies`, `write_comment`, `media`, `subtitles`, `author`, and `user_content`.
- [ ] Infer capabilities from all existing command names, descriptions, and columns so every registered site can appear in a coverage report without hand-editing every adapter.
- [ ] Preserve explicit command metadata as an override for future adapters.
- [ ] Verify that named platforms expose unique coverage beyond generic read/search.

### Task 2: Social Coverage CLI

**Files:**

- Create: `src/commands/social.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/commands/social.test.ts`

- [ ] Add `unicli social coverage` with `--site`, `--capability`, and `--highlighted` filters.
- [ ] Return rows with `site`, `commands`, `capabilities`, and `highlighted`.
- [ ] Keep output under the existing formatter envelope.

### Task 3: Hierarchical Comment Model

**Files:**

- Create: `src/social/comments.ts`
- Modify: `src/adapters/xiaohongshu/comments.ts`
- Modify: `src/adapters/bilibili/comments.ts`
- Modify: `src/adapters/youtube/comments.ts`
- Test: `tests/unit/social/comments.test.ts`

- [ ] Define stable comment rows: `platform`, `content_id`, `comment_id`, `parent_id`, `depth`, `path`, `author`, `text`, `likes`, `replies`, and `created`.
- [ ] Normalize legacy platform rows without dropping existing fields.
- [ ] Update the TS comment adapters to emit the unified fields while retaining old aliases.

### Task 4: Video Subtitle Extraction

**Files:**

- Create: `src/social/video-text.ts`
- Create: `src/adapters/yt-dlp/subtitles.ts`
- Modify: `src/engine/download.ts`
- Modify: `src/engine/steps/download.ts`
- Test: `tests/unit/social/video-text.test.ts`
- Test: `tests/unit/download.test.ts`

- [ ] Build deterministic `yt-dlp` subtitle arguments for `--write-sub`, `--write-auto-sub`, language selection, VTT conversion, and optional browser-cookie reuse.
- [ ] Add `cookies_from_browser` to the download step for video downloads.
- [ ] Expose `unicli yt-dlp subtitles <url>` as the cross-platform subtitle command.
- [ ] Report missing subtitle output as a loud error, not an empty success.

### Task 5: Verification

**Files:**

- Existing local tests and typecheck.

- [ ] Run focused unit tests for social capability, comments, video-text, and download utilities.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm test` if focused tests and typecheck pass.
