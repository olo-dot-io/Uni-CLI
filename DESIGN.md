# Uni-CLI Public Design System

## Direction

The public surface combines two layers. Functional controls retain the compact behavior of [Appica UI](https://appica.dev/ui), ported from `appica-dev/appica-ui@26de9b1e02d2fb48694ae52d2371b1bbd71ee9d6` into VitePress and Vue. The campaign layer is **The Green Observatory**: a 1960s space-program future imagined through smooth oil glazing, continuous viridian color fields, and an asymmetric editorial composition. Appica's React runtime is not added. Its MIT license is preserved in `docs/.vitepress/theme/APPICA-UI-LICENSE.txt`.

The homepage begins with a real copy target rather than explanatory prose. Visitors can copy either the npm installation command or a concise instruction for an agent. The observatory, telescope, and ringed planet carry the exploration metaphor; the interface remains modern and legible above the media plane. Each later section presents one action or one structured result. Decorative dividers, status dots, glowing traces, and ornamental diagrams are absent.

## Typography

Geist Sans is the only authored public typeface. The variable WOFF2 build and its OFL license remain vendored. Interface labels, prose, code, and numbers share the same family; browsers provide glyph fallback only when Geist has no matching glyph.

| Role             | Size                       | Line height | Weight    |
| ---------------- | -------------------------- | ----------- | --------- |
| Hero             | `clamp(48px, 5.3vw, 74px)` | `0.98`      | `650`     |
| Homepage section | `clamp(32px, 4vw, 44px)`   | `1.05`      | `650`     |
| Document title   | `clamp(34px, 4vw, 42px)`   | `1.1`       | `620`     |
| Body             | `16px`                     | `1.6`       | `400`     |
| Interface        | `14px`                     | `1.45`      | `500–600` |
| Label            | `12px`                     | `1.35`      | `540–600` |

The scale follows Appica's compact steps and prevents large jumps between adjacent roles. Headlines use balanced wrapping. Long-form text stays within 68 characters. Numeric data uses tabular figures. Inputs remain at least 16px on mobile.

`@chenglou/pretext@0.0.6` is pinned at the text-layout boundary. Semantic DOM remains authoritative.

## Color

Documentation maps Appica's OKLCH primitives to semantic tokens. The homepage uses a fixed campaign palette in both appearances so the painting and product identity do not change when documentation switches theme.

| Homepage role | Value                    |
| ------------- | ------------------------ |
| Deep forest   | `oklch(0.185 0.052 158)` |
| Viridian      | `oklch(0.41 0.088 158)`  |
| Moss          | `oklch(0.64 0.075 130)`  |
| Sage          | `oklch(0.84 0.045 122)`  |
| Paper         | `oklch(0.95 0.03 97)`    |
| Ivory         | `oklch(0.975 0.022 91)`  |
| Burnt orange  | `oklch(0.66 0.16 46)`    |

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

Burnt orange appears only on the primary copy action and selected-result feedback. Contrast is tuned independently for documentation appearances.

## Components

- The base radius is `14px`, matching Appica's `0.875rem` token.
- Buttons are 48px high on marketing surfaces and 40px in dense documentation controls.
- Pressed controls use `scale(0.97)` with a short interruptible transition.
- Grouped content uses a muted background or low, diffused shadow instead of a border line.
- Cards represent a real operation, candidate, receipt, surface, statistic, or route.
- Tables use row spacing and surface contrast rather than drawn separators.
- Focus rings remain visible in light and dark appearance.

## Composition

The homepage hero is one full-viewport painted field. A compact floating navigation capsule belongs to the hero and scrolls away with it; documentation pages retain the standard VitePress navigation. Copy occupies the quiet left side while the observatory and planet establish a diagonal on the right. The installation component sits at the handoff between headline and image and remains the primary action. There is no inset frame or pale perimeter. The large `Uni-CLI` footer closes the page like the bottom of a printed campaign poster, and the VitePress home margin is removed so no canvas appears beneath it.

The following story uses two full-image editorial panels instead of a feature table. The orbital archive frames discovery; the repair bay frames the inspect-and-repair loop. A compact strip of official product marks establishes the real software surface before these panels. Equal card geometry keeps surfaces, statistics, and entry paths calm and regular.

At 760px the composition becomes a two-part poster: a solid forest command field above and a cropped observatory painting below. At 640px the command and copy action stack without hiding either mode. Receipt and entry layouts collapse to one column. No content exceeds the viewport.

Documentation keeps a 780px reading measure. Navigation, search, sidebars, tables, code blocks, version notices, catalog filters, and agent controls reuse the same tokens.

## Motion

No component runs a continuous animation. The interface contains no breathing light, orbit, pulse, moving route, or decorative entrance sequence. Hover and press feedback change only the relevant color, shadow, or transform and finish within 160ms. `prefers-reduced-motion: reduce` removes transforms and transitions.

## Public assets

- README preview: `docs/public/site-preview.webp`
- Open Graph preview: `docs/public/site-preview-og.jpg`
- Homepage painting: `docs/public/green-observatory.webp`
- Operation discovery painting: `docs/public/orbital-archive.webp`
- Adapter repair painting: `docs/public/orbital-repair.webp`
- Product marks: `docs/public/brands/*.svg`
- Mascot: `docs/public/mascot-otter.png`

The three homepage paintings are original generated assets with no embedded type, logo, or third-party artwork. Their shared art direction is a viridian 1960s orbital program rendered with smooth oil glazing, broad controlled brushwork, calm negative space, ivory planetary light, and restrained brass or orange accents. Speckled dots, tiling texture, repetitive grime, stippling, halftone, dithering, microdots, canvas weave, and film grain are excluded at generation time. Product marks come from Simple Icons under CC0; trademarks remain with their owners. The preview and Open Graph image are generated from the production homepage after visual verification.
