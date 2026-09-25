# LIFE PROGRESS — DESIGN AUDIT (PHASE 8.1)

Scope: read-only inspection of the production UI (no code changed).
Sources: `css/theme.css`, `css/base.css`, `css/components.css`, `css/screens.css`
(2,523 lines), `index.html`, `js/ui.js`, `js/router.js`, `js/tabbar-dock.js`,
`js/launch.js`, `js/celebration.js`, `js/screens/*.js`.

---

## 1. COLOR

### Current palette (dark, default)

| Token | Value | Where used |
|---|---|---|
| `--bg` | `#0a0e14` | app background |
| `--bg-soft` | `#0d1320` | desktop backdrop |
| `--surface` | `#111826` | cards, sheets |
| `--surface-2/3` | `#1a2332` / `#233046` | inputs, tracks, chips |
| `--text` / `--text-2` / `--text-3` | `#edf2f7` / `#94a3b8` / `#5b6b7d` | 3-step text ramp |
| `--accent` | `#2dd4bf` (teal) | primary actions, rings, active nav |
| success / warning / danger / info | `#34d399` / `#fbbf24` / `#f87171` / `#60a5fa` | pills, states |

Light theme mirrors these with `#f4f6f9` bg, `#0d9488` accent.

### Findings

- **The palette is Tailwind-adjacent.** `#2dd4bf`/`#14b8a6` are exactly
  Tailwind's `teal-400/500`; `#94a3b8` is `slate-400`; `#0f172a` is `slate-900`;
  `#34d399`, `#fbbf24`, `#f87171`, `#60a5fa` are `emerald-400`, `amber-400`,
  `red-400`, `blue-400`. The app literally ships a default Tailwind ramp, which
  is a large part of the "AI-generated app" feeling.
- **One accent does all jobs.** Teal signals: brand, primary buttons, active
  nav, water progress, gym progress, streaks, selection, links. Nothing owns a
  meaning; color does not communicate.
- **Semantic colors are over-exposed as translucent pills.** Nearly every list
  row carries 1–3 `pill-*` chips (category, priority, deadline, streak). On the
  Goals screen a single card can show 3 pills; the Gym dashboard card shows 4.
- **Gradients are decorative and load-bearing at once.** `--hero-grad`
  (radial teal-tinted), `--overlay-grad`, streak-card gradient fill, avatar
  gradient (`accent → info`), achievement radial glows, celebration glow.
- **Glow shadows.** Buttons carry `0 6px 18px rgba(45,212,191,.28)` (teal glow);
  streak card `0 0 24px`; badges `0 0 18px`; ring `0 0 14px`. Glow = "AI
  startup" visual signature #1.
- **Contrast risks.** `--text-3 #5b6b7d` on `--surface #111826` ≈ 4.0:1 — below
  AA for small text; it is used at 10–11px in tab labels and bar labels.
  `--accent #2dd4bf` on white text (`--on-accent #04211d` is fine) but accent
  text on `--surface` ≈ 8:1 OK; in light theme `--accent #0d9488` on `#f4f6f9`
  ≈ 3.9:1 — borderline for small text (used for section links at 13px).
- **Dark-only assumption in places.** Photo-view meta (`#dbeafe`), camera ink
  (`#e7eef6`), template notes (`#93a3b3`) hard-code dark-theme values.

## 2. SHAPE

| Radius token | Value | Notes |
|---|---|---|
| `--r-s` | 10px | small |
| `--r-m` | 16px | cards, stats, photos |
| `--r-l` | 22px | primary cards, dialog |
| `--r-xl` | 28px | hero, sheet top, tab dock |

Plus many **off-scale** values: buttons 14px, icon buttons 13px, inputs 13px,
segmented 14px, empty-state icon 24px, avatars 24px/50%, bar chart 8/4px,
quick-action circles 18px, hist-day 12px, achievement cards 22px…

### Findings

- **Pill-radius (999px) overuse:** chips, pills, toasts, streak-best, hist
  chips, hist marks, progress tracks, launch skip button, mood… 20+ component
  classes. Almost every status is a capsule.
- **Radius inflation:** 16–28px on everything makes cards feel like soap bars;
  the 28px dock + 28px sheet + 22px cards + 16px tiles leaves no hierarchy —
  everything is equally "soft".
- **Inconsistent scale:** 8 real radii in use (10/11/12/13/14/16/18/22/24/28)
  plus circles — implementation drift, not a system.

## 3. SURFACES

- **Cards everywhere:** every content block is a `--surface` card with 1px
  border + soft shadow, typically 16–20px padding, stacked with 24px gaps.
  The dashboard is 6 cards; Water is 5; Gym is 7+.
- **Glass:** the tab dock uses `backdrop-filter: blur(18px)` + `--glass` tint;
  launch skip button blurs; photo date labels blur; celebration backdrop blurs.
- **Layering is flat-ish:** surface-2/3 steps exist but most cards are the same
  elevation; hierarchy is carried by repetition (more cards = more hierarchy).
- **Borders everywhere** at 14% alpha — visually noisy on dense screens.

## 4. TYPOGRAPHY

- **System font stack only** (`-apple-system, Segoe UI, Roboto…`). No display
  face, no numerals face, no identity.
- Scale: 11/13/15/17/22/28/34px, body 15px, line-height 1.5.
- Headings: 22px/800 with `-0.02em` — every page header identical
  (word + italic-ish muted sub-slogan: "Stay hydrated 💧", "Stronger than
  yesterday", "Track → understand → improve", "Make it yours").
- Metrics: 22–34px at weight 800 with tabular-nums — the strongest type on
  every screen, but with no typographic personality (same font as everything).
- **Weight inflation:** 700–800 for almost all emphasis; 600 is the body
  default for sub-labels. Semi-bold-everything reads as shouty.
- The only personality moment: the launch quote uses **Georgia serif** — an
  accident of styling, not a system, and it never appears anywhere else.
- All-caps micro-labels (`0.05–0.34em` tracking) appear in ~6 places with 3
  different tracking values.

## 5. SPACING

- Scale 4–40px is sane, page padding 20px, section rhythm 24px.
- Card padding is inconsistent: 16/20px (`card`, `card-tight`) plus dozens of
  inline `style="…margin-top:…"` overrides in screen files — spacing rhythm is
  decided ad hoc per screen.
- Density is low-everything: big cards, big chips, 52px quick-action circles,
  68px shutter — the app feels padded rather than calm; whitespace is consumed
  by card chrome instead of empty space.

## 6. ICONOGRAPHY

- Single hand-drawn 24px/2px-stroke icon set (28 icons) in `js/ui.js` — good
  consistency; slightly playful curves (droplet, flame) against generic
  stroke geometry.
- Used at 11–30px with no optical-size adjustment; 12px flame inside pills is
  near-illegible.
- Emojis appear inside copy (💧 in water sub, ✓ in pills) competing with the
  icon set.

## 7. NAVIGATION

- **Floating glass capsule dock** (`js/tabbar-dock.js`, ~500 lines): 6 tabs,
  backdrop-blur capsule, sliding active capsule (rAF-animated 300ms), plus a
  **horizontal drag gesture** on the dock with axis thresholds, hysteresis,
  release-to-navigate, haptics.
- Screenshots show the dock floating 12px above the bottom edge — visually
  detached, overlapping content, classic "AI app" furniture.
- Home indicator/gesture-zone conflicts: the dock sits inside the iOS swipe
  zone; the drag gesture on it competes with the system edge swipes.
- Active state = teal icon + teal capsule tint + glow — three signals for one
  state; label contrast at 10px `--text-3` inactive is weak.
- Discoverability: Photos/Achievements/History are not reachable from the dock
  (buried in Gym/Settings cards) — the "Your Journey" card is a nav item
  disguised as a dashboard card.

## 8. MOTION

- Durations 120/240/420ms; `--spring` overshoot easing
  (`cubic-bezier(0.34, 1.56, 0.64, 1)`) on nearly every press: buttons scale
  0.96, cards 0.985, chips 0.94, tiles 0.95, icon buttons 0.9, qa-circles 0.88.
- **Stagger animation on every screen render** (`.stagger` up to 8 children
  rising 420ms each) — every navigation replays the same "everything floats
  up" choreography.
- `floaty` infinite animation on every empty-state icon (bounces forever).
- Count-up + ring sweep + bar sweep on every dashboard mount; amount pulse on
  every water add; capsule slide on every tab change; launch sequence with
  blurred Ken Burns background, serif mark, quote, rule, brand (5 elements,
  1.3s choreography) once per session; celebration panel with glow ring +
  8-step staggered reveal.
- Reduced-motion is handled well (media queries + JS matchMedia) — the one
  production-strength part of the motion system.

## 9. UX

- **Strengths:** consistent touch targets (≥44px), honest empty states,
  keyboard parity on interactive cards, focus-visible outlines, aria labels,
  offline-first, real data everywhere, strong reduced-motion support.
- **Weaknesses:**
  - Everything is a card → no visual hierarchy; the eye has no anchor. The
    dashboard buries the daily ring (the #1 motivational object) inside card
    #2 under a quote block.
  - Pills-per-row raises cognitive load; color is noise, not meaning.
  - The floating dock costs 76px of bottom space and still overlaps content.
  - Gestures (dock drag) are clever but undiscoverable and redundant with taps.
  - Sub-slogans under every title ("Stronger than yesterday") read as
    motivational filler — repeated canned tone.
  - No screen has a distinctive layout: all screens are "title → stats row →
    cards → list" — generic dashboard monotony.

## 10. SHARED PATTERNS (for redesign leverage)

- Shared: `ui.icon()` (28 icons), `ring`, `bars`, `pill`, `chip`, `card`,
  `sheet`, `dialog`, `toast`, `empty`, `stat`, `settings-group`, `mood-row`,
  `avatar`.
- Global: theme tokens (single source of truth — a redesign is a token swap +
  component restyle), `.stagger`, `screen-enter`, launch overlay.
- Repeated: page-header-with-slogan, stat-grid trio, section-head with link,
  card-in-section, pill-in-row.

---

**Verdict:** the bones (tokens, components, a11y) are solid; the skin (Tailwind
palette, glass dock, pill floods, glow shadows, springy everything) is what
reads as "AI-generated". A distinctive identity is achievable mainly by
re-planning **color meaning, typography personality, shape restraint, surface
honesty, and motion calm** — not by rebuilding structure.
