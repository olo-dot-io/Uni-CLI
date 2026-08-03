# Uni-CLI Public Design System

## Direction

The public surface uses the component language of [Appica UI](https://appica.dev/ui): quiet neutral canvases, navy ink, blue interaction color, compact controls, soft grouped surfaces, and short state feedback. The implementation ports the official tokens and behavior from `appica-dev/appica-ui@26de9b1e02d2fb48694ae52d2371b1bbd71ee9d6` into the existing VitePress and Vue boundary. Appica's React runtime is not added to the documentation bundle. Its MIT license is preserved in `docs/.vitepress/theme/APPICA-UI-LICENSE.txt`.

Each section presents one action or one structured result. Spacing, background contrast, and radius create hierarchy. Decorative dividers, status dots, glowing traces, gradients, and ornamental diagrams are absent. Authored copy stays short.

## Typography

Geist Sans is the only authored public typeface. The variable WOFF2 build and its OFL license remain vendored. Interface labels, prose, code, and numbers share the same family; browsers provide glyph fallback only when Geist has no matching glyph.

| Role             | Size                     | Line height | Weight    |
| ---------------- | ------------------------ | ----------- | --------- |
| Hero             | `clamp(36px, 4vw, 48px)` | `1.04`      | `620`     |
| Homepage section | `clamp(30px, 3vw, 38px)` | `1.1`       | `610`     |
| Document title   | `clamp(34px, 4vw, 42px)` | `1.1`       | `620`     |
| Body             | `16px`                   | `1.6`       | `400`     |
| Interface        | `14px`                   | `1.45`      | `500–600` |
| Label            | `12px`                   | `1.35`      | `540–600` |

The scale follows Appica's compact steps and prevents large jumps between adjacent roles. Headlines use balanced wrapping. Long-form text stays within 68 characters. Numeric data uses tabular figures. Inputs remain at least 16px on mobile.

`@chenglou/pretext@0.0.6` is pinned at the text-layout boundary. Semantic DOM remains authoritative.

## Color

The site maps Appica's OKLCH primitives to semantic tokens. The light surface is white with cool gray grouping; the dark surface is deep navy rather than neutral black.

| Role             | Light                    | Dark                     |
| ---------------- | ------------------------ | ------------------------ |
| Canvas           | `oklch(1 0 0)`           | `oklch(0.13 0.02 263)`   |
| Muted surface    | `oklch(0.967 0.003 264)` | `oklch(0.21 0.02 263)`   |
| Strong surface   | `oklch(0.928 0.006 264)` | `oklch(0.278 0.02 263)`  |
| Primary text     | `oklch(0.21 0.02 263)`   | `oklch(0.985 0.002 248)` |
| Secondary text   | `oklch(0.446 0.018 256)` | `oklch(0.707 0.018 256)` |
| Primary action   | `oklch(0.21 0.02 263)`   | `oklch(0.985 0.002 248)` |
| Secondary action | `oklch(0.623 0.188 259)` | `oklch(0.707 0.165 255)` |
| Success          | `oklch(0.696 0.17 162)`  | `oklch(0.765 0.177 163)` |

Filled emphasis appears once per decision context. Blue indicates interaction. Green is reserved for successful or selected runtime state. Contrast is tuned independently for each appearance.

## Components

- The base radius is `14px`, matching Appica's `0.875rem` token.
- Buttons are 48px high on marketing surfaces and 40px in dense documentation controls.
- Pressed controls use `scale(0.97)` with a short interruptible transition.
- Grouped content uses a muted background or low, diffused shadow instead of a border line.
- Cards represent a real operation, candidate, receipt, surface, statistic, or route.
- Tables use row spacing and surface contrast rather than drawn separators.
- Focus rings remain visible in light and dark appearance.

## Composition

The homepage uses a centered 960px working surface. The hero contains one intent composer and four equally weighted stages. Later sections repeat the same grid, radius, spacing, and text hierarchy for the live route, operating surfaces, data, and starting points.

At 960px the receipt and surface grids reduce columns. At 760px the receipt stacks and entry points become one column. At 640px controls become full width where useful and the hero stages form a balanced 2×2 grid. No content exceeds the viewport.

Documentation keeps a 780px reading measure. Navigation, search, sidebars, tables, code blocks, version notices, catalog filters, and agent controls reuse the same tokens.

## Motion

No component runs a continuous animation. The interface contains no breathing light, orbit, pulse, moving route, or decorative entrance sequence. Hover and press feedback change only the relevant color, shadow, or transform and finish within 160ms. `prefers-reduced-motion: reduce` removes transforms and transitions.

## Public assets

- README preview: `docs/public/site-preview.webp`
- Open Graph preview: `docs/public/site-preview-og.jpg`
- Mascot: `docs/public/mascot-otter.png`

The preview and Open Graph image are generated from the production homepage after visual verification.
