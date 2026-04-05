# Design System: Uni-CLI

## 1. Visual Theme & Atmosphere

Uni-CLI's visual identity lives at the intersection of terminal precision and infrastructure confidence. As part of the OLo ecosystem (XAgent), it shares the Geist font family and shadow-as-border structural language, but diverges sharply in atmosphere: where OLo is warm and inviting, Uni-CLI is dark, monospaced, and unapologetically technical. The design communicates: "this tool was built by engineers who ship to production."

The primary canvas is a near-black with cool undertone (`#0a0a0a`) — colder than OLo's warm `#1a1914`, colder than OpenCode's warm `#201d1d`. This is deliberate: Uni-CLI is infrastructure, not a chatbot. Infrastructure is cold, precise, reliable. Text uses the Geist Mono typeface exclusively for headings, code, terminal output, and technical content, with Geist Sans reserved only for body prose (documentation paragraphs, blog posts). This dual-font approach distinguishes Uni-CLI from OpenCode (Berkeley Mono everywhere) while maintaining the OLo ecosystem coherence (Geist family).

The accent system uses a single functional color: **Terminal Green** (`#22c55e`) — the universal color of "command succeeded." This replaces Vercel's workflow tricolor and OpenCode's blue accent. Green is the only accent. Everything else is grayscale. This extreme restraint creates instant recognition: if it's green-on-dark with monospace, it's Uni-CLI.

**Key Characteristics:**

- Geist Mono for all headings, code, technical content — monospace as identity
- Geist Sans for body prose only — the exception, not the rule
- Cool near-black primary (`#0a0a0a`) — colder than OLo and OpenCode
- Terminal Green (`#22c55e`) as sole accent — no blue, no red, no orange in brand
- Shadow-as-border from OLo/Vercel ecosystem (`box-shadow: 0 0 0 0.5px`)
- 2px border radius — sharper than Vercel (6px), sharper than OpenCode (4px)
- Negative letter-spacing on Geist Mono headings (-1px to -2px at display sizes)
- Terminal-style prompt indicators (`>`, `$`, `→`) as decorative elements

## 2. Color Palette & Roles

### Primary

| Token              | Value     | Usage                           |
| ------------------ | --------- | ------------------------------- |
| `background`       | `#0a0a0a` | Page background (website, docs) |
| `surface`          | `#111111` | Cards, panels, code blocks      |
| `surface-elevated` | `#1a1a1a` | Hover states, elevated panels   |
| `foreground`       | `#e5e5e5` | Primary text                    |
| `secondary`        | `#737373` | Secondary text, muted           |
| `tertiary`         | `#525252` | Tertiary text, labels           |

### Accent

| Token           | Value     | Usage                                         |
| --------------- | --------- | --------------------------------------------- |
| `accent`        | `#22c55e` | Terminal green — success, CTAs, active states |
| `accent-dim`    | `#166534` | Green tinted backgrounds, badges              |
| `accent-bright` | `#4ade80` | Hover on green elements                       |

### Semantic (from Apple HIG, same as OpenCode/OLo)

| Token     | Value     | Usage                             |
| --------- | --------- | --------------------------------- |
| `danger`  | `#ef4444` | Error states, destructive actions |
| `warning` | `#f59e0b` | Warnings, caution                 |
| `info`    | `#3b82f6` | Informational, links in docs      |

### Borders & Shadows

| Token           | Value                                                           | Usage                            |
| --------------- | --------------------------------------------------------------- | -------------------------------- |
| `border`        | `rgba(255, 255, 255, 0.06)`                                     | Default separator (0.5px shadow) |
| `border-strong` | `rgba(255, 255, 255, 0.12)`                                     | Interactive element borders      |
| `shadow-card`   | `0 0 0 0.5px rgba(255,255,255,0.06), 0 2px 4px rgba(0,0,0,0.4)` | Card elevation                   |

## 3. Typography Rules

### Font Family

- **Headings / Code / Technical**: `Geist Mono`, fallbacks: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
- **Body Prose**: `Geist`, fallbacks: `system-ui, -apple-system, sans-serif`
- **OpenType**: `"liga"` enabled globally, `"tnum"` for tabular numbers

### Hierarchy

| Role            | Font       | Size | Weight | Line Height | Letter Spacing |
| --------------- | ---------- | ---- | ------ | ----------- | -------------- |
| Display         | Geist Mono | 48px | 700    | 1.00        | -2.0px         |
| Page Title      | Geist Mono | 36px | 700    | 1.10        | -1.5px         |
| Section Heading | Geist Mono | 24px | 600    | 1.25        | -1.0px         |
| Card Title      | Geist Mono | 18px | 600    | 1.33        | -0.5px         |
| Body            | Geist      | 16px | 400    | 1.60        | normal         |
| Body Medium     | Geist      | 16px | 500    | 1.60        | normal         |
| Code / Terminal | Geist Mono | 14px | 400    | 1.50        | 0px            |
| Caption         | Geist Mono | 12px | 400    | 1.50        | 0.5px          |
| Badge           | Geist Mono | 11px | 600    | 1.00        | 0.5px          |

### Principles

- **Mono-first**: If content could reasonably be in monospace, it IS monospace. Headings, stats, command names, site names, badges, navigation — all Geist Mono.
- **Sans for reading**: Long-form text (documentation paragraphs, blog posts, descriptions longer than 2 sentences) uses Geist Sans for readability.
- **Negative tracking on headings**: Display and heading sizes use negative letter-spacing to create density and urgency.
- **Positive tracking on captions**: Small text uses slight positive tracking for legibility.

## 4. Component Styling

### Terminal Block (hero element)

```css
.terminal {
  background: #111111;
  border-radius: 8px; /* exception: terminal gets 8px */
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.06),
    0 8px 32px rgba(0, 0, 0, 0.6);
  font-family: "Geist Mono", monospace;
  padding: 24px;
}
.terminal-header {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
}
.terminal-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}
.terminal-prompt {
  color: #22c55e; /* green prompt */
}
.terminal-output {
  color: #e5e5e5;
}
```

### Card

```css
.card {
  background: #111111;
  border-radius: 2px;
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.06),
    0 2px 4px rgba(0, 0, 0, 0.4);
  padding: 24px;
}
.card:hover {
  background: #1a1a1a;
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.12),
    0 4px 8px rgba(0, 0, 0, 0.5);
}
```

### Button

```css
.btn-primary {
  background: #22c55e;
  color: #0a0a0a;
  font-family: "Geist Mono", monospace;
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.5px;
  padding: 8px 20px;
  border-radius: 2px;
  border: none;
}
.btn-secondary {
  background: transparent;
  color: #e5e5e5;
  box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.12);
  /* same font/size as primary */
}
```

### Badge / Pill

```css
.badge {
  font-family: "Geist Mono", monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 2px;
  background: rgba(34, 197, 94, 0.1);
  color: #22c55e;
}
```

### Stat Counter

```css
.stat {
  font-family: "Geist Mono", monospace;
  font-size: 48px;
  font-weight: 700;
  letter-spacing: -2px;
  color: #e5e5e5;
}
.stat-label {
  font-family: "Geist Mono", monospace;
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: #525252;
}
```

## 5. Spacing & Layout

### Base Unit: 4px

| Token      | Value | Usage                   |
| ---------- | ----- | ----------------------- |
| `space-1`  | 4px   | Inline gaps             |
| `space-2`  | 8px   | Component inner padding |
| `space-3`  | 12px  | Small section gaps      |
| `space-4`  | 16px  | Standard padding        |
| `space-6`  | 24px  | Card padding            |
| `space-8`  | 32px  | Section gaps            |
| `space-12` | 48px  | Large section gaps      |
| `space-16` | 64px  | Page section separators |
| `space-24` | 96px  | Hero spacing            |

### Layout

- Max width: 1200px (content), 720px (documentation prose)
- Grid: 12-column, 24px gutter
- Mobile breakpoint: 768px (stack to single column)

## 6. Iconography

- No icon library. Custom SVG only where essential (terminal prompt, arrow, chevron, check, x).
- Icons use color directly — no background containers (OLo pattern).
- 16px default size, 1.5px stroke weight.

## 7. Motion

- Default transition: `150ms ease`
- Hover/focus: `200ms ease-out`
- Page transitions: `300ms ease-in-out`
- `prefers-reduced-motion: reduce` — disable all non-essential animation

## 8. Relationship to OLo Ecosystem

| Property         | OLo (XAgent)                                                   | Uni-CLI                           |
| ---------------- | -------------------------------------------------------------- | --------------------------------- |
| Font heading     | Geist Sans                                                     | **Geist Mono**                    |
| Font body        | Geist Sans                                                     | Geist Sans                        |
| Background light | `#f7f4ed` (warm cream)                                         | N/A (dark only for website)       |
| Background dark  | `#1a1914` (warm brown)                                         | `#0a0a0a` (cool near-black)       |
| Accent           | Contextual (warm)                                              | **`#22c55e` (terminal green)**    |
| Border technique | Shadow-as-border                                               | Shadow-as-border (shared)         |
| Border radius    | 8px default                                                    | **2px default**                   |
| Identity         | Warm, approachable, macOS                                      | **Cold, precise, infrastructure** |
| Shared           | Geist family, shadow-as-border, spacing scale, semantic colors |

When Uni-CLI components appear inside the OLo interface (e.g., terminal output panel), they should use Uni-CLI's color palette within their container but respect OLo's outer layout spacing. The Geist font family ensures typographic coherence.

## 9. Website Structure

### Landing Page

```
[Terminal Green dot] Uni-CLI

[Display] The last CLI an AI agent will ever need.

[Terminal Block — live demo]
$ unicli hackernews top --limit 3
$ unicli twitter search "AI agents" -f json
$ unicli blender render scene.blend

[Stats Row]
96 SITES    582 COMMANDS    23 STEPS    0 RUNTIME DEPS

[Feature Grid — 3 columns]
Card: Self-Repair (5-level healing loop diagram)
Card: Universal (web + desktop + cloud + service)
Card: Agent-Native (~80 tokens per call)

[Coverage Section — dark grid with site logos/names]

[Pipeline Section — horizontal step flow visualization]

[CTA] npm install -g unicli
```

### Documentation (VitePress)

- Dark theme matching website palette
- Sidebar: Geist Mono for section titles
- Content: Geist Sans for prose, Geist Mono for code
- Syntax highlighting: green accent for strings, gray for comments

### Domain

Primary: `unicli.dev`
Hosted: Vercel
SSL: Automatic via Vercel
