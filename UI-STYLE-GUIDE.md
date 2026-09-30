# AI HYROS — UI Style & Design Guide

The visual system for this app, rebuilt Sep 2026 with Alex to match the
dashboard and console graphics on hyros.com (the /enterprise stage: the
"app.hyros.com · dashboard" window over the `hyros-mcp` console). It is the
HYROS **CL1** design language applied to a working tool. **This document is
self-contained — never reference the Framer site or the hyros.com pages when
working on this app.** Everything a future session needs (tokens, fonts,
assets, component patterns, rules) is cited here and lives in this repo.

The single source of truth for every value below is
[`public/styles.css`](./public/styles.css) — its `:root` block defines all
tokens, and **no color may ever be hardcoded outside it** (app.js contains
zero color literals; keep it that way).

---

## 1. Principles

1. **Cream ground, white windows.** The page is warm cream (`--bg`). Product
   lives in white windows with a hairline, radius 12 and the three-dot bar
   with a centered mono address (`.win` + `.winbar`). Never a dark surface
   in the working UI; INK is reserved for the console and the primary button.
2. **Purple marks what HYROS did.** Brand purple paints what HYROS attributed,
   changed or selected: the attributed Revenue/ROAS columns (the lavender
   band), the highlight KPI tile, the active tab, sorted headers, drill
   links, the attribution-model label, focus rings. It never means "good".
3. **INK is the action.** The one primary action per screen (`button.primary`:
   gate "Open dashboard", topbar "Refresh", column panel "Save as my default
   view") is an INK button, radius 7. Everything else is a white hairline
   button. Never two INK buttons visible in the same context.
4. **Labels mono, figures serif, the rest Inter.** Every label, header, pill,
   badge and caption is Geist Mono 10.5px uppercase. Every big figure is
   P22 Mackinac. Body and cells are Inter 12.5–14px.
5. **Status colors live in data only.** Green `#1F8A5B` and terracotta
   `#B5533A` appear inside cells, pills and money tones — never on chrome,
   icons or buttons.
6. **Sven sparingly.** The lavender pixel Sven appears in exactly two
   moments — the sign-in window and loading states. Never decorate the
   working UI with him.
7. **Dense is a feature.** This is a reporting tool; keep table density.
   Calm comes from hierarchy and restraint, not padding.
8. **Say a thing once.** Shared context (the KPI date range) prints one
   time above a group, never repeated per card.
9. **Functionality is sacred.** Styling changes must never alter behavior;
   app.js edits are limited to cosmetic markup strings (class names, asset
   paths).

---

## 2. Color tokens (`public/styles.css` `:root`)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FAF9F5` | the cream page ground |
| `--surface` | `#FFFFFF` | windows, cards, the chrome |
| `--surface-2` | `#FCFBF8` | KPI tiles, table header rows, quiet cards, drawer head |
| `--surface-3` | `#F6F5F0` | panel ground, hovers, bar tracks |
| `--surface-4` | `#EDEBE3` | cream2: segmented-control tracks, window-bar dots, the Seed badge |
| `--lavbg` | `#EEEEFB` | the HYROS band: attributed columns, active tab, highlight tile, purple pills |
| `--lav` | `#A5A4FA` | lavender data: funnel/share bars, Sven, the demo badge dot |
| `--border` | `rgba(31,30,29,.11)` | every hairline |
| `--border-2` | `rgba(31,30,29,.18)` | input/select borders |
| `--rule` | `rgba(31,30,29,.06)` | row dividers inside a window |
| `--ink` | `#1F1E1D` | text, the primary button, the console |
| `--ink-2` | `#55534E` | secondary text |
| `--ink-3` | `#8B8984` | mono labels, quiet text |
| `--brand` | `#5150F6` | THE accent — what HYROS attributed / changed / selected |
| `--brand-2` | `#403FD4` | purple hover |
| `--good` | `#1F8A5B` | positive money / status — data only |
| `--bad` | `#B5533A` | negative money / status / errors — data only |
| `--bad-fill` | `rgba(217,119,87,.16)` | the terracotta tint behind bad pills and error notes |
| `--warn` | `#B0781E` | warnings: partial data, no-show / refunded, "needs attention" — never an error |
| `--warn-fill` | `rgba(176,120,30,.14)` | the amber tint behind warning pills |

Tints are built from these with rgba (purple `rgba(81,80,246,.3)` borders,
`.16` focus rings; green `rgba(31,138,91,.07)` fills) — never new hex values.
There is no pink and no rainbow hairline in this system.

## 3. Shape & elevation

- `--r-btn: 7px` buttons, inputs, selects. `--r-tile: 10px` KPI tiles and
  notes. `--r-win: 12px` windows, cards, panels. `6px` for tabs, chips,
  badges and pills; `999px` only for journey-step and LTV-multiplier pills.
- `--shadow-win: 0 26px 60px -34px rgba(31,30,29,.35)` — windows (`.win`).
  `--shadow-card: 0 12px 34px -26px rgba(31,30,29,.35)` — cards and bare
  table wraps. `--shadow-pop: 0 24px 50px -30px rgba(31,30,29,.4)` —
  floating panels; the drawer carries its own left-cast shadow.
- Borders are always 1px hairlines (`--border`; `--border-2` on inputs);
  row dividers inside a window use `--rule`.

## 4. Typography

Fonts are **self-hosted in this repo** — `public/assets/fonts/`:

| File | Family | Weight | License note |
|---|---|---|---|
| `inter-regular.woff2` … `inter-bold.woff2` | Inter | 400 / 500 / 600 / 700 | OFL (open) |
| `mackinac-book.woff2` | P22 Mackinac | 400 (Book) | Licensed, Book weight ONLY — do not fake bold/italic, do not subset |
| `geist-mono.woff2` | Geist Mono | 400–500 (variable) | OFL (from Google Fonts) |

- `--sans` (Inter) — body 14px (`letter-spacing: -0.005em`), table cells
  13px (CRM 12.5px), tabs/chips 12.5px, buttons 13.5px. Weight 400; 500
  for names, totals, the active tab/chip. Never 600+ in the working UI.
- `--mono` (Geist Mono) — **every label**: KPI labels, table headers, pills,
  badges, the window address, the kicker, drawer section titles, dates,
  counts, the attribution model, percentages in bars. 10.5px uppercase with
  `.1em` tracking (`.pill` 10px / `.06em`; the window address 11px, not
  uppercase). Mono is also the console voice (`--term` + `--term-text`).
- `--serif` (P22 Mackinac Book) — **figures and titles only**: `.kpi-value`
  (25px), `.ltv-step b` (19px), `.scale-stat b` (17px), `.fpanel h3` (19px)
  and the gate headline (30px). Regular weight, `-0.012em` tracking. Never
  the serif in running text, buttons or table cells.
- All numeric surfaces set `font-variant-numeric: tabular-nums`.

## 5. Brand assets (`public/assets/brand/`)

| File | What | Usage rules |
|---|---|---|
| `hyros-logo-blue.svg` | The full Hyros logo (pixel mark + serif wordmark, brand blue) | Topbar (`.brand-logo`, 20px tall — the site's nav size). Never retype "Hyros" in a live font. |
| `hyros-mark-blue.svg` | The pixel mark alone | Favicon. |
| `sven-lavender.svg` | Sven, the 13×15 pixel grid in lavender, `shape-rendering: crispEdges` | Gate (78px) and loading states (`.sven-load`, 52px, gentle 1.8s bob — off under reduced motion). Nowhere else. |
| `sven-blue.png` | Legacy 28×32 blue Sven | Kept for rollback only; not referenced. |

Pixel art rule: Sven is a fixed grid — render the SVG, never smooth-scale a
raster, never add badges, shadows or recolouring outside the brand
colourways (lavender here).

## 6. Component patterns (the site's dashboard kit, applied)

- **Window** `.win` + `.winbar` — white, hairline, radius 12, `--shadow-win`.
  The bar: three 9px cream2 dots left, the address centered in mono 11px
  (`app.hyros.com · performance report`, `· crm`, `· sign in`). The report
  and CRM tables and the gate card are windows; a `.table-wrap` inside a
  window drops its own border/radius/shadow.
- **Topbar** — 56px white bar, hairline bottom: the logo (20px), the account
  meta in 12.5px with quiet dot separators, the attribution model as a
  purple mono label with a 6px purple dot (`.meta-pill`, the site's
  "Model · …"), then the origin badge and the INK Refresh.
- **Tabs (views)** `.tabs .tab` — the site's app nav: 12.5px items, radius
  6; the active one is a lavender pill in purple 500. Selectors keep
  `.tabs button.tab` specificity so the generic button hover can never
  repaint a tab — keep it if you touch them.
- **Segmented control** `.chipset` / `.chip` — the site's `.bx-tabs`: a
  cream2 track (radius 8, padding 3) with 12.5px chips; the active chip is
  a white card with INK text and a 1px shadow. Chip counts (`.chip-count`)
  are mono and turn lavender/purple on the active chip.
- **Buttons** — white, hairline, radius 7, 13.5px 400; hover `--surface-2`.
  `button.primary` INK / white text (principle 3).
- **Inputs / selects** — white, `--border-2`, radius 7; focus = purple
  border + `rgba(81,80,246,.16)` ring. The controls search flexes
  `1 1 150px` between 130–250px so the row never wraps at desktop width.
- **KPI tiles** `.kpi` — the site's `.eo-kpi`: `--surface-2`, hairline,
  radius 10, mono label, 25px serif figure, mono sub. `.kpi.hy` is the
  highlight tile (lavender, purple figure) — the HYROS-attributed Revenue
  KPI, one per screen (`KPI_HY` in app.js). Money tones wear `.good`/`.bad`.
  The date range prints ONCE above the grid as `.kpi-range`.
- **Tables** — white; sticky header row on `--surface-2` in mono uppercase;
  `--rule` dividers; 13px cells; sticky first column; sticky `--surface-2`
  totals row at weight 500. Row hover `--surface-2` (first col
  `--surface-3`). **The HYROS band**: attributed columns (`HY` in app.js:
  `totalRevenue`, `revenue`, `roas`) render `td.hy` purple on `#F4F4FD` (lavender on hover
  and in totals), `th.hy` purple — the site's HYROS-column signature.
  No zebra striping. CRM runs one step denser (`#crmTable` 12.5px / `8px 9px`).
- **Pills** `.pill` — mono 10px, hairline, radius 6, `--surface-2`. Status
  tints: `.pill.stage`/`.ok` green, `.pill.warn` amber, `.pill.bad` terracotta,
  `.pill.fb` lavender/purple. The CRM table and drawer use the SAME tints.
- **Badges** `.badge` — mono with a status dot: `.live` lavender/purple,
  `.seed` cream2, `.demo` INK with a lavender dot.
- **Notes** `.note` — the quiet card (`--surface-2`, hairline, radius 10,
  13px). `.note.err` terracotta tint.
- **Funnel / share bars** — lavender (`--lav`) fills on `--surface-3`
  tracks; figures inside bars in mono INK; share percentages mono purple;
  journey steps are white hairline stadiums, the last one lavender/purple;
  `.jpath-pct`, `.ltv-rank`, `.ltv-mult` are lavender/purple mono pills.
- **Scale chart** — INK average line, dashed purple marginal line,
  terracotta dotted ceiling, green saturation line; mono axis text.
- **Drawer** — right sheet `min(460px, 94vw)`, `--surface-2` head with a
  mono subtitle, 32px square icon buttons, scrim `rgba(31,30,29,.32)`;
  timeline icons in `--surface-2` circles (sales: lavender/purple); click
  paths in mono.
- **Gate** — a centered 420px window ("app.hyros.com · sign in"): Sven,
  a purple mono kicker, a 30px serif headline with the purple last word,
  the input, the INK submit.

## 7. The feel layer (micro-interactions)

- Focus: global `:focus-visible` 2px purple outline; inputs get the ring
  instead. Checkboxes: `accent-color: var(--brand)`.
- Press: `button:active` nudges `translateY(0.5px)` (text-link buttons
  `.drill`/`.name-drill`/`.cohort-row` excluded).
- Transitions: 130ms color/background on buttons/chips/tabs.
- Entrances via `@starting-style` (Chromium; graceful no-op elsewhere):
  drawer slides 26px + fades (240ms `cubic-bezier(.2,.7,.3,1)`), scrim
  fades (200ms), column panel pops -6px (160ms).
- Sven's loading bob: 1.8s ease-in-out, 4px.
- **Every animation dies under `prefers-reduced-motion: reduce`.** Any new
  motion must join that media block.
- `[hidden] { display: none !important }` guards the show/hide system —
  never give an element a bare `display: flex/grid` that could resurrect it
  while `hidden`.

## 8. Do / never

**Do**: add new colors as `:root` tokens; build tints with rgba on the
tokens; keep one INK action per screen; keep every label mono; keep tables
dense; test at 1440×900 (primary) — the app is a desktop tool.

**Never**: dark surfaces in the working UI; pink or a rainbow hairline
(retired with the CL1 system); purple to mean "good"; green/terracotta on
chrome; the serif below 17px or in running text; Inter above 500 weight;
new hex literals in app.js or inline styles; zebra striping; Sven beyond
the gate and loading; smooth-scaled pixel art; motion without a
reduced-motion opt-out.

## 9. Verifying a visual change

```
node scripts/devserver.mjs        # local preview on 127.0.0.1:4321 (seed data)
```

Then screenshot with Playwright at 1440×900 and eyeball: gate, report
(+ column panel open), drill drawer, CRM, and the demo tabs (Funnel, Ad
LTV, Scale Advisor, Tracking Health — click the origin badge to enter demo
mode). The devserver serves woff2/svg/png MIME types — fonts and brand
assets render exactly as in production.
