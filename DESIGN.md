# Uni-CLI Public Design System

## Direction

The public surface combines two layers. Functional controls retain the compact behavior of [Appica UI](https://appica.dev/ui), ported from `appica-dev/appica-ui@26de9b1e02d2fb48694ae52d2371b1bbd71ee9d6` into VitePress and Vue. The campaign layer is **The Green Observatory**: a 1960s space-program future imagined through smooth oil glazing, continuous viridian color fields, and an asymmetric editorial composition. Appica's React runtime is not added. Its MIT license is preserved in `docs/.vitepress/theme/APPICA-UI-LICENSE.txt`.

The homepage begins with a real copy target rather than explanatory prose. Visitors can copy either the npm installation command or a concise instruction for an agent from one dark command console. The observatory, telescope, and ringed planet carry the exploration metaphor; the interface remains modern and legible above the media plane. Each later section presents one action or one structured result. Decorative dividers, status dots, glowing traces, ornamental diagrams, and hover-only feedback are absent.

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

| Role           | Light                    | Dark                     |
| -------------- | ------------------------ | ------------------------ |
| Canvas         | `oklch(0.975 0.018 92)`  | `oklch(0.145 0.04 158)`  |
| Muted surface  | `oklch(0.925 0.03 105)`  | `oklch(0.215 0.045 157)` |
| Strong surface | `oklch(0.885 0.035 114)` | `oklch(0.26 0.05 157)`   |
| Primary text   | `oklch(0.17 0.055 158)`  | `oklch(0.975 0.02 92)`   |
| Secondary text | `oklch(0.37 0.035 154)`  | `oklch(0.84 0.025 106)`  |
| Primary action | `oklch(0.215 0.06 158)`  | `oklch(0.94 0.025 96)`   |
| Signal         | `oklch(0.65 0.15 47)`    | `oklch(0.72 0.14 54)`    |

Burnt orange appears only as a prompt, selection, or state signal. Documentation neutrals inherit a green or paper tint so light and dark appearances belong to the same product.

## Components

- Radius follows one four-step family: `12px` for compact marks, `16px` for controls, `28px` for cards, and `36px` for large panels. Nested surfaces step down exactly one level.
- Buttons are 48px high on marketing surfaces and 40px in dense documentation controls.
- Pressed controls use `scale(0.97)` with a short interruptible transition.
- Grouped content uses a muted background or low, diffused shadow instead of a border line.
- Cards represent a real operation, candidate, receipt, surface, statistic, or route.
- Tables use row spacing and surface contrast rather than drawn separators.
- Focus rings remain visible in light and dark appearance.

## Composition

The homepage hero is one full-viewport painted field. A compact floating navigation capsule belongs to the hero and scrolls away with it; documentation uses the same capsule proportions and always exposes Docs, Operations, Reference, Integrations, and Architecture. Copy occupies the quiet left side while the observatory and planet establish a diagonal on the right. The installation component sits at the handoff between headline and image and remains the primary action. There is no inset frame or pale perimeter. The large `Uni-CLI` footer closes the page like the bottom of a printed campaign poster, and the VitePress home margin is removed so no canvas appears beneath it.

The following story is a four-scene orbital sequence for find, select, run, and repair. Native scroll pins the viewport while the paintings rotate through one spatial ring, then the last scene expands to the full viewport before handing off to the structured receipt. A compact strip of official product marks establishes the real software surface before the sequence. The marks sit directly on the dark field without individual tiles.

The final chapters stay inside the same observatory rather than returning to a generic card grid. The interface atlas places five substrates and live catalog counts over one panoramic instrument gallery. The launch deck then stacks over that scene and expands from an inset painted panel to the full viewport as the visitor continues scrolling. Entry routes remain ordinary links inside the composition. The footer returns to paper and fills the `Uni-CLI` letterforms with the atlas painting, producing an image-cut wordmark instead of a solid display line.

At 760px the composition becomes a two-part poster: a solid forest command field above and a cropped observatory painting below. The orbital sequence becomes four complete static cards in normal continuous scroll rather than a constrained 3D stage. The atlas and launch deck become long-form painted panels with controls in normal document flow. At 640px the copy label collapses to its icon while both command modes remain available. Receipt and entry layouts collapse to one column. No content exceeds the viewport.

Documentation keeps a 780px reading measure. Navigation, search, sidebars, tables, code blocks, version notices, catalog filters, and agent controls reuse the same tokens.

## Motion

No component runs an autonomous continuous animation. The hero and chapter titles enter once with a short character stagger. In the desktop orbital chapter, native scroll is the source of truth and a 68ms time-based damper only interpolates its visual progress. The document has no root snap points and no midpoint scene lock; position, depth, rotation, copy opacity, and the final expansion stay continuous and reversible. Mobile cards remain complete static scenes in ordinary continuous scroll.

Pointer velocity briefly reveals a masked duplicate through an SVG displacement filter; the turbulence source is never rendered as texture, so the paintings retain smooth color fields. Image overscan is not capped by the documentation image rule, preventing any edge exposure during pointer depth. The atlas and launch deck use sub-percent depth shifts, while the launch panel uses a transform-only scroll expansion. Scroll and pointer work is coalesced through `requestAnimationFrame` and stops when input stops. `prefers-reduced-motion: reduce` presents the scenes as static panels with no displacement, stagger, or transform.

## Public assets

- README preview: `docs/public/site-preview.webp`
- Open Graph preview: `docs/public/site-preview-og.jpg`
- Homepage painting: `docs/public/green-observatory.webp`
- Operation discovery painting: `docs/public/orbital-archive.webp`
- Operation relay painting: `docs/public/orbital-relay.webp`
- Structured memory painting: `docs/public/orbital-memory.webp`
- Adapter repair painting: `docs/public/orbital-repair.webp`
- Interface atlas painting: `docs/public/interface-atlas.webp`
- Launch deck painting: `docs/public/launch-deck.webp`
- Product marks: `docs/public/brands/*.svg`
- Mascot: `docs/public/mascot-otter.png`

The seven homepage paintings are original generated assets with no embedded type, logo, or third-party artwork. Their shared art direction combines smooth-panel oil painting, contemplative Romantic scale, real Apollo, Gemini, Voyager, Vostok, Hubble, and Saturn V references, and restrained late-1960s cinematic geometry. Calm viridian fields, ivory planetary light, and isolated orange signals replace decorative machinery. Speckled dots, tiling texture, repetitive grime, stippling, halftone, dithering, microdots, canvas weave, and film grain are excluded at generation time. Product marks come from Simple Icons under CC0; trademarks remain with their owners. The preview and Open Graph image are generated from the production homepage after visual verification.
