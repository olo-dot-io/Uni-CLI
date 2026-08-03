# Uni-CLI Public Design System

## Direction: interface, not explanation

The public site presents Uni-CLI as working software. The homepage opens on one product window where an intent becomes a selected operation, an execution route, and a receipt. Supporting sections use live data, aligned rows, and direct entry points. Prose appears only when the interface cannot carry the meaning itself.

The visual lineage follows contemporary tool interfaces: a quiet textured field, one centered working surface, warm paper, dense black ink, restrained orange interaction color, fine separators, and soft elevation. It avoids generic terminal dashboards, card mosaics, decorative icon circles, violet gradients, oversized marketing copy, and repeated feature summaries.

## Typography

Geist Sans is the only authored public typeface. It serves display, interface, code, numbers, and Latin text; browsers supply glyph fallback only where Geist has no character coverage. The pinned variable WOFF2 build is vendored with its OFL license.

| Role           | Size                       | Line height | Weight    |
| -------------- | -------------------------- | ----------- | --------- |
| Hero           | `clamp(46px, 6.2vw, 76px)` | `0.97`      | `610`     |
| Section title  | `clamp(44px, 6vw, 78px)`   | `0.98`      | `600`     |
| Document title | `clamp(40px, 5vw, 58px)`   | `1.02`      | `620`     |
| Body           | `16px`                     | `1.65`      | `400`     |
| Interface      | `14px`                     | `1.4`       | `500–580` |
| Label          | `12px`                     | `1.25`      | `520–560` |

Headlines use tight tracking and balanced wrapping. Descriptions use pretty wrapping. Long-form text stays within 68 characters. Changing values use tabular numbers. Links take underline metrics from Geist. Inputs remain at least 16px on mobile.

`@chenglou/pretext@0.0.6` remains pinned at the text-layout boundary. Semantic DOM remains authoritative.

## Color

Colors are semantic OKLCH tokens. Orange identifies interaction. Green identifies successful runtime state. Neutral ink and paper carry structure; decorative color never borrows an interactive meaning.

| Role           | Token                | Light                   |
| -------------- | -------------------- | ----------------------- |
| Canvas         | `--uni-paper`        | `oklch(0.978 0.009 88)` |
| Raised surface | `--uni-paper-raised` | `oklch(0.994 0.004 88)` |
| Primary text   | `--uni-ink`          | `oklch(0.205 0.008 75)` |
| Secondary text | `--uni-muted`        | `oklch(0.49 0.012 75)`  |
| Separator      | `--uni-rule`         | `oklch(0.895 0.012 84)` |
| Interaction    | `--uni-accent`       | `oklch(0.61 0.15 39)`   |
| Success        | `--uni-success`      | `oklch(0.66 0.16 148)`  |

Dark appearance is tuned independently. `prefers-contrast: more` widens lightness gaps. Visited links use a separate muted plum token. Filled emphasis appears once per decision context.

## Surfaces

- Use borders for dividers, tables, form outlines, and selected state.
- Use layered translucent shadows for elevation and container edges.
- Product windows use a 24px outer radius. A surface inset by 10px uses a 14px inner radius.
- Images receive a 1px inner outline: pure black at 10% in light appearance and pure white at 10% in dark appearance.
- Cards appear only for real adapter, release, or statistic objects.
- Controls are at least 42px tall on marketing surfaces and 38px in dense documentation controls.

## Composition

- The hero fills `calc(100svh - 64px)` and centers one product window.
- Working width is 1240px; documentation measure is 780px.
- Sections have one job: route, surface, or entry.
- Lists and receipts use aligned rows and separators rather than decorative containers.
- At 760px the receipt stacks, surface rows collapse to label/detail pairs, and hero stages become a 2×2 grid.
- At 640px header utilities move behind the menu, controls become full width where needed, and no content exceeds the viewport.

## Interaction

- Pressable controls use `scale(0.96)` with a 150ms interruptible transition.
- Hover changes use explicit color, shadow, or transform properties; `transition: all` is prohibited.
- The first-load product window uses one 520ms opacity/blur/12px translation sequence. Actions follow after 120ms.
- High-frequency navigation and filtering use instant state changes or transitions no longer than 150ms.
- `prefers-reduced-motion: reduce` removes entrance and transform effects.
- Focus rings remain visible in light and dark appearance. Copy status is announced through a stable polite live region.

## Assets

- Homepage field: `docs/public/interface-field.webp`
- README preview: `docs/public/site-preview.webp`
- Open Graph preview: `docs/public/site-preview-og.jpg`
- Mascot: `assets/mascot-otter.png`

The homepage field is an original project asset. It contains no embedded text, product UI, logo, or third-party artwork.
