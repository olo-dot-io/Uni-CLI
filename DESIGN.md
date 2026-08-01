# Uni-CLI Public Design System

## Direction: Operational Cartography

Uni-CLI presents software control as a field of explicit routes. The visual system borrows the spatial discipline of infrastructure maps and architectural models: quiet terrain, precise relays, one highlighted path, and enough empty space for a decision to remain legible.

The direction rejects generic terminal dashboards and neon AI imagery. A command remains visible when it explains a real operation. Decoration never pretends to be telemetry.

## Brand Materials

| Role             | Token              | Value     |
| ---------------- | ------------------ | --------- |
| Night field      | `--uni-night`      | `#11130f` |
| Warm paper       | `--uni-paper`      | `#f2ede2` |
| Deep paper       | `--uni-paper-deep` | `#e6decd` |
| Ivory text       | `--uni-ivory`      | `#f3ecd9` |
| Primary ink      | `--uni-ink`        | `#20231d` |
| Brass route      | `--uni-brass`      | `#d1ad68` |
| Cyan signal      | `--uni-signal`     | `#8fcbd0` |
| Muted night text | `--uni-muted`      | `#bbb39f` |

Brass identifies primary paths and calls to action. Cyan marks live signals, selected state, and focus. Semantic error and warning colors stay available inside product feedback, but they do not become brand decoration.

Surfaces use flat material transitions, thin separators, and restrained grain from the hero artwork. Avoid glass cards, broad glow, purple-blue gradients, excessive rounding, and stacked panels that repeat the same hierarchy.

## Typography

All public font files ship with the site.

| Role                  | Family                       | Use                                          |
| --------------------- | ---------------------------- | -------------------------------------------- |
| Display and interface | Bricolage Grotesque Variable | Headlines, navigation, section titles, stats |
| Simplified Chinese    | Noto Sans SC Variable        | Chinese display and prose                    |
| Technical notation    | IBM Plex Mono                | Commands, receipts, labels, metadata         |

Display type uses condensed width, moderate weight, and tight tracking. Body copy stays compact and readable. Monospace labels are short, uppercase, and functional. Long technical prose remains sans-serif.

`@chenglou/pretext@0.0.6` runs at the text-layout boundary. Semantic DOM remains the source of content and accessibility.

## Composition

- Landing surfaces use a 12-column field with a maximum working width of 1380px.
- The hero places copy in the quiet left field and routing artwork on the right.
- Section transitions alternate night, paper, brass, and deep paper to establish pace without adding containers.
- Section headlines can span 6–9 columns. Explanatory copy stays below 680px.
- Desktop sections use 84–150px vertical space. Mobile sections use 78px and 20px horizontal padding.
- Lists express comparison through aligned rows and separators. Cards appear only when the content has a real object boundary.

The GitHub README shares the generated hero asset and the same hierarchy: identity, first route, task routing, contract, surfaces, receipts, repair, and trust.

## Core Public Components

### Landing hero

The hero contains one declarative promise, one short explanation, two entry points, a first command, and generated runtime counts. The artwork contains no embedded text, logo, terminal, or fictional UI.

### Task routing table

The operation catalog handles discovery and contracts. The routing sequence below selects the execution operator:

1. structured API for public data and stable service contracts;
2. local runtime for file, process, and OS boundaries;
3. browser protocol for authenticated or private web contracts;
4. semantic browser for page-only web flows;
5. accessibility tree for native desktop applications;
6. visual computer use for pixel-only or unstructured interfaces.

The table describes selection order. It must not imply hidden fallback.

### Operation receipt

A concrete receipt uses a live-verified public operation. It shows intent, ranked registry candidates, one selected operation, operator, effect, strategy, and structured outcome. Candidate operations remain visible so the product distinction is understandable without an interactive demo or a large JavaScript island.

### Documentation

Documentation uses the same typography and materials with a narrower 800px reading column. Generated catalogs use filter rows, flat cards, and visible operation names. Code blocks retain VitePress behavior and use IBM Plex Mono.

## Interaction And Motion

- Entrances use opacity and vertical translation over 600–950ms with a decelerating curve.
- Hero artwork settles once through a small scale change.
- Hover feedback stays within 180–200ms and uses color, border, or a 2px translation.
- No continuous animation, shader, cursor follower, or requestAnimationFrame decoration.
- `prefers-reduced-motion: reduce` removes entrances, translations, and smooth scrolling.
- Focus rings use the cyan signal token and remain visible on night and paper fields.
- Copy controls report success and failure through visible `aria-live` text.

## Responsive Behavior

At 840px the field becomes stacked, the route table becomes a two-column label/detail list, and the operation receipt uses two columns. At 640px every primary section and receipt becomes one column. Theme, social, and language controls move out of the narrow nav bar so search and the menu button remain inside the viewport.

Every release screenshot must verify:

- no horizontal overflow at 390px;
- the command remains selectable and copy state is announced;
- hero text keeps contrast over the artwork;
- the operation receipt preserves its selected state;
- reduced-motion styles remove nonessential motion;
- English and Chinese homepages share the same information architecture.

## Assets

- Landing and README hero: `docs/public/operation-field.webp`
- Open Graph crop: `docs/public/operation-field-og.jpg`
- Mascot: `assets/mascot-otter.png`

The routing artwork can evolve while the left-side negative space, brass/cyan material language, and absence of embedded text remain stable.
