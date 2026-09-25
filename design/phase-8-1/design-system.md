# LIFE PROGRESS — PROPOSED DESIGN SYSTEM (PHASE 8.1)

Status: **PROPOSAL — not implemented.** This file is the reference if the
direction is approved. Prototype: `prototypes/index.html`.

---

## IDENTITY IN ONE LINE

**"The Paper Log"** — Life Progress as a well-printed daily training log:
warm paper-light surfaces, ink-dark nights, a single ember-orange accent for
*done*, one serif voice for numbers and moments that matter.

Feeling: HUMAN · PERSONAL · CALM · PREMIUM · GROUNDED · TACTILE.

---

## 1. COLOR

### Philosophy

- **Warm neutrals, not blue-grays.** Paper in light, soft ink in dark. Every
  neutral is pulled ~5° toward orange so white feels like paper and dark feels
  like evening, never like a terminal.
- **One accent with one meaning.** Ember orange (`ember`) is reserved for
  *completion and today*. It appears only when you did something. Neutral ink
  otherwise; calm by default, warm when earned.
- **Category tints replace semantic pill noise.** Four quiet category hues
  (water/gym/goals/journal) are used ONLY in data graphics (calendar dots,
  bar charts, small markers) — never as pill backgrounds.
- Status colors exist but render as text + icon, not filled capsules.

### Dark theme ("Ink", default)

| Token | Value | Meaning |
|---|---|---|
| `--bg` | `#121110` | warm near-black ink |
| `--bg-raised` | `#1a1918` | screen sections, wells |
| `--surface` | `#201e1c` | cards |
| `--surface-2` | `#292624` | inputs, tracks |
| `--text` | `#ece7df` | warm white |
| `--text-2` | `#a8a094` | secondary (≥4.6:1 on bg) |
| `--text-3` | `#7a7268` | muted/caption (≥3.2:1, large only) |
| `--divider` | `#2b2825` | hairlines |
| `--border` | `#332f2b` | card edges |
| `--ember` | `#e8863a` | DONE / today / primary action |
| `--ember-press` | `#d97a30` | pressed accent |
| `--ember-dim` | `rgba(232,134,58,0.14)` | tint fills |
| `--water` | `#7fb4c9` | hydration data |
| `--gym` | `#c98a7f` | training data |
| `--goals` | `#a5b87f` | goal data |
| `--journal` | `#c9b27f` | journal data |
| `--success` | `#8fbc7f` | text-level success |
| `--warning` | `#d9b36a` | text-level warning |
| `--danger` | `#d97b6c` | destructive |
| `--info` | `#9db8d9` | informational |
| `--achieve` | `#d9c08a` | achievement metal (brass) |

### Light theme ("Paper", default-day)

| Token | Value | Meaning |
|---|---|---|
| `--bg` | `#f5f1ea` | warm paper |
| `--bg-raised` | `#efe9e0` | wells |
| `--surface` | `#fbf8f3` | cards |
| `--surface-2` | `#f0eae1` | inputs, tracks |
| `--text` | `#26221d` | ink |
| `--text-2` | `#6b6357` | secondary (≥5:1) |
| `--text-3` | `#948b7d` | caption (large only) |
| `--divider` | `#e2dbd0` | hairlines |
| `--border` | `#dcd4c8` | card edges |
| `--ember` | `#c05f1e` | accent (AA on paper) |
| `--ember-press` | `#a85116` | pressed |
| `--ember-dim` | `rgba(192,95,30,0.10)` | tint |
| `--water` | `#4d7f96` | hydration |
| `--gym` | `#96543f` | training |
| `--goals` | `#64783c` | goals |
| `--journal` | `#8a6d35` | journal |
| `--success` | `#4e7a42` | success text |
| `--warning` | `#9c6d1c` | warning text |
| `--danger` | `#b04a35` | destructive |
| `--info` | `#4a6a94` | informational |
| `--achieve` | `#8a6d2a` | brass |

### Rules

1. No gradients on UI surfaces. The launch/hero uses a **flat photo or a flat
   ink field** — never a colored radial.
2. No glow shadows, ever. Elevation = border + one soft warm shadow.
3. Accent usage per screen ≤ 3 elements: the today marker, the primary
   button, one "earned" state.
4. Emoji never render color inside data UI; they stay in journal copy only.

---

## 2. TYPOGRAPHY

### Philosophy

Two voices, like a printed log: a **serif for the record** (numbers, page
titles, launch quote — the "hand that wrote the book") and the **system sans
for the machinery** (labels, buttons, body). No webfont download is required
for the prototype; the recommended implementation pairing is
**Fraunces (display serif) + Inter (UI)** with system-font graceful fallback —
a decision for the owner (Question Q2).

### Scale

| Role | Face | Size/Weight | Notes |
|---|---|---|---|
| Display / metric XL | serif | 44–56 / 600 | daily ring number, launch quote |
| Page title | serif | 28 / 600 | one per screen, no sub-slogan |
| Section heading | sans | 13 / 700, caps, +0.08em | quiet eyebrow style |
| Body | sans | 15 / 400 | line-height 1.55 |
| Secondary | sans | 13 / 400–500 | |
| Caption | sans | 11 / 500, caps, +0.06em | |
| Metric (inline) | serif | 22–26 / 600 | stat values, tabular |
| Button | sans | 15 / 600 | |
| Navigation | sans | 11 / 600 | active 700 |

### Hierarchy rules

- Numbers that matter get the serif and the space around them; nothing else
  competes above weight 600.
- Section headers become small caps eyebrows — this alone removes ~40% of the
  visual noise versus today's 17px bold section titles.
- Only ONE italic element in the app: the journal body (it is handwriting-
  adjacent, personal).

---

## 3. SHAPE

### Radii (three, plus circle)

| Token | Value | Used for |
|---|---|---|
| `--r-s` | 6px | inputs, chips, small tiles |
| `--r-m` | 10px | cards, sheets, modals, media |
| `--r-l` | 14px | hero blocks only |
| circle | 50% | checks, avatars, shutter, dots |

### Philosophy

- **Tighter is more serious.** 10px cards read as print modules; 24–28px soap
  bars read as toys.
- **Pills are retired.** Capsules exist only for progress tracks (data) and
  the launch skip (overlay). Status is text + icon; filters are rectangular
  6px chips; the nav is a full-width bar.
- Buttons: `--r-s` (6px) — squared like print buttons; primary = ember fill,
  secondary = outline, destructive = outline in danger ink (no filled red).

### Existing shapes to reduce (explicit list)

- Tab dock `--r-xl` 28px → full-width bar, top corners 0.
- Sheet top radius 28px → 14px.
- Cards 22px → 10px; stat tiles 16px → 10px; photo tiles 16px → 6px.
- Chips/pills/toasts 999px → 6px (toasts may keep 10px).
- Quick-action circles 18px → 10px squares.
- Goal check circle stays a circle (semantic check).

---

## 4. SURFACES & CARDS

- **Paper hierarchy, not glass:** `bg → raised well → surface card`. Cards sit
  on slightly darker wells in light mode (drop-in shadow) and slightly lighter
  in dark (lift), giving tactile direction without blur.
- **One border, one shadow:** `1px var(--border)` + `0 1px 2px rgba(0,0,0,.06)`
  (light) / `0 1px 2px rgba(0,0,0,.35)` (dark). No 24px ambiances, no glow.
- **Section dividers return.** Long hairline `--divider` rules replace
  card-around-everything on list screens (Water entries, Personal bests,
  Settings groups keep cards; lists get rules).
- **Zero backdrop-filter** in the app chrome. The launch overlay and photo
  viewer keep their scrims (they are content, not chrome).
- **The dashboard keeps exactly two cards:** the Day Record (hero, flat ink or
  photo) and the Today ring card. Everything else is typography on paper.

---

## 5. SPACING

- Same 4–40px scale, enforced: page padding **20px**; section gap **32px**
  (up from 24 — whitespace becomes the separator instead of cards);
  card padding **16px**; list row padding **14px** vertical.
- Density: slightly tighter rows, more generous screen rhythm — "dense inside,
  airy outside".

---

## 6. ICONOGRAPHY

- Keep the existing 28-icon set (it is consistent and hand-made) but:
  - standardize stroke **1.75px**, 24px box, rendered 20/22/24px;
  - no icons below 16px (drop 11–12px flame-in-pill usage — streaks become
    serif numerals);
  - category glyphs allowed two colors max (ink + category tint).
- Emojis removed from all UI chrome (kept inside journal entry text only).

---

## 7. MOTION

### Philosophy — "settling, not springing"

Everything moves like paper and ink: quick, small, no overshoot. Nothing
bounces; nothing floats forever; nothing loops.

| Token | Value |
|---|---|
| `--d-fast` | 100ms (press, toggles) |
| `--d-base` | 180ms (sheets, fades) |
| `--d-slow` | 320ms (screen enter, ring sweep) |
| `--ease` | `cubic-bezier(0.2, 0, 0, 1)` — standard ease-out, no overshoot |

- **Press feedback:** opacity/brightness dip (surface darkens 4%), scale
  removed. Physical like pressing paper, not squishing rubber.
- **Screen transitions:** 150ms fade + 8px rise of the whole page, once.
  `.stagger` is deleted; content does not choreograph.
- **Progress:** ring/bar sweeps 320ms ease-out, once, on data change only.
- **Completion (the delight budget):** one ember moment per completion —
  the check draws (200ms) + a single soft ring pulse (300ms) + haptic.
  That is the celebration for goals/water/journal.
- **Achievement unlock:** keeps a full-screen moment (this is the one
  deliberately theatrical event) but restyled: paper card, serif title, brass
  badge, single reveal, no glow loop.
- **Empty states:** static. The `floaty` infinite bounce is removed.
- Launch: photo fades in (400ms), quote fades (200ms later), tap anywhere /
  auto 2.2s, exit fade 250ms. No Ken Burns, no blur-in.
- Reduced motion: unchanged behavior — everything instant or simple fades
  (current implementation is already good; keep it).

---

## 8. NAVIGATION

### Proposal: full-width flat bottom bar

- 6 destinations (unchanged IA), full-width, **surface + top hairline**, no
  float, no blur, no capsule, radius 0.
- Height 56px + safe area; icons 22px; labels 11px.
- Active state: **ink icon + ink label + 2px ember underline bar** under the
  icon, no tint block. Inactive: `--text-3`.
- No sliding capsule, no drag-to-switch. Gestures are removed from nav
  (see gesture audit); taps + system back/swipe remain.
- History/Achievements/Photos remain secondary destinations reached from
  Dashboard and Gym — but the dashboard gains a persistent compact header row
  (avatar → settings, calendar icon → history) so History is one tap away.

---

## 9. INTERACTION STATES

| State | Treatment |
|---|---|
| Hover (desktop) | background shifts to `--surface-2` |
| Active/press | brightness dip, no scale |
| Focus-visible | 2px `--ember` outline, 2px offset (keep current a11y behavior) |
| Selected (filter) | 6px chip: ink fill, paper text |
| Disabled | 45% opacity, no shadow |
| Completed | ember check + label dims one step |

---

## 10. COMPONENT PHILOSOPHY

- **Card** = module of record: flat, bordered, 10px, 16px padding.
- **Row** = default listing unit with hairline dividers.
- **Chip** = filter only. **Pill** = abolished (data markers replace it).
- **Sheet** = bottom modal, 14px top corners, grabber kept (it is useful),
  backdrop `rgba(0,0,0,.5)` no blur.
- **Toast** = bottom-centered ink bar, 10px, appears above nav bar, 180ms.
- **Stat** = serif number over caps caption, no box (boxes only when part of
  a grid of 3+).
- **Empty state** = centered glyph + one serif sentence + quiet button; no
  animation.
