# DESIGN REVIEW — LIFE PROGRESS PHASE 8.1

Status: **PROPOSAL — awaiting owner review.** No production file was touched.
Prototype: `prototypes/index.html` (open directly in a browser).

---

## DESIGN GOAL

The owner does not like the current visual identity: it reads as an
AI-generated generic dashboard (glass, pills, gradients, glow, bounce). The
goal is one coherent, ownable identity that feels human, personal, calm,
premium, grounded and motivating — where delight comes from *progress*, not
decoration.

## CURRENT PROBLEMS (summary; details in design-audit.md)

1. Default-Tailwind palette (teal `#2dd4bf`, slate ramp) = "AI app" signature.
2. One accent for everything → color communicates nothing.
3. Pills/capsules on nearly every row; 999px radius on 20+ components.
4. Floating glass dock with sliding capsule + drag gesture — clever but
   generic, costs space, overlaps content, hides History/Photos.
5. Glow shadows (teal button glow, streak glow, badge glow), decorative
   gradients (hero, streak card, avatar).
6. Spring overshoot on every press; `.stagger` choreography on every
   navigation; infinite `floaty` bounce on empty states.
7. Same screen skeleton everywhere (title → stats → cards → list); every
   header carries a canned sub-slogan.
8. System font everywhere with weight inflation (600–800) — no typographic
   personality; the one serif moment (launch quote) is an accident.

## PROPOSED IDENTITY — "THE PAPER LOG"

A well-printed daily training log. Warm paper in light mode, warm ink in
dark mode. A single **ember orange** accent that only appears when something
is *done* or *today*. Serif numerals and titles — the record; quiet sans
labels — the machinery. Flat surfaces, hairlines, 10px corners. Motion that
settles, never springs. The one theatrical moment left in the app is the
achievement unlock — because it was earned.

## COLOR SYSTEM

Full token tables in `design-system.md` §1. Core:

- Dark: bg `#121110`, surface `#201e1c`, text `#ece7df`/`#a8a094`,
  ember `#e8863a`, water `#7fb4c9`, gym `#c98a7f`, goals `#a5b87f`,
  journal `#c9b27f`, brass `#d9c08a`.
- Light: bg `#f5f1ea`, surface `#fbf8f3`, ink `#26221d`, ember `#c05f1e`,
  category tints at AA-contrast equivalents.
- Rules: no gradients, no glow, accent ≤ 3 elements/screen, category colors
  only in data graphics, semantic states as text+icon not capsules.

## TYPOGRAPHY

Serif (prototype: Georgia; implementation proposal: Fraunces) for display
metrics, page titles, launch quote. Sans (system/Inter) for everything else.
Scale + roles in `design-system.md` §2. One italic: journal body.
Section headers become 13px caps eyebrows.

## SHAPE SYSTEM

Radii 6 / 10 / 14px + circles. Pills abolished; chips 6px; buttons 6px;
cards 10px; sheets 14px top. Full list of existing shapes to reduce in
`design-system.md` §3.

## NAVIGATION

**Current:** floating glass capsule dock, sliding tint capsule, drag with
release-to-navigate, 76px bottom cost, History/Photos/Achievements buried.

**Proposed:** full-width flat bar, 56px + safe-area, surface + top hairline,
6 tabs, ink active with 2px ember underline, no capsule, no drag, no blur.
Dashboard header gains avatar (→ settings) and calendar (→ history) so no
seventh tab is needed. IA unchanged — visual behavior only.

## GESTURES

| Gesture | Where today | Verdict | Reason |
|---|---|---|---|
| Dock horizontal drag / release-to-navigate | tab bar | **REMOVE** | redundant with taps, undiscoverable, conflicts with system edge swipes, drives ~500 lines of stateful JS |
| Tap tab | tab bar | **KEEP** | primary nav |
| Compare slider drag | photo compare | **KEEP** | core interaction of that screen |
| Pose-alignment drag | smart camera | **KEEP** | core interaction |
| Exercise-reorder handle drag | template editor | **KEEP** | utility, has buttons as fallback |
| Scroll/swipe vertical | everywhere | **KEEP** | native |
| Quick-add chips / buttons | water, gym | **KEEP** | they make gestures unnecessary |
| Swipe-to-delete rows | (absent today) | **OPTIONAL** | could be added later; delete buttons already exist |

Core rule honored: every gesture has a tap/button alternative; nothing
requires a gesture to understand the app.

## MOTION

**Current:** spring overshoot presses, 8-child stagger on every nav, floaty
empty-state bounce, count-ups everywhere, capsule travel, Ken Burns launch.

**Proposed:** 100/180/320ms, single ease-out, no overshoot, no stagger, no
loops. Press = brightness dip. Completion = check draw + one soft pulse +
haptic. Achievement = the one full-screen moment, restyled on paper.
Detail in `design-system.md` §7.

## SCREEN CHANGES (one line each; full detail in SCREEN_INVENTORY.md)

- **Launch:** flat photo + serif quote, 2 taps max, no Ken Burns/blur-in.
- **Dashboard:** "Day Record" header (date + completion line) replaces hero +
  quote + 6 cards; today ring + concise log rows; header nav to history.
- **Water:** bigger serif ring number, quick-add as rectangular buttons,
  week chart with water-tint bars, list rows with hairlines.
- **Gym:** stat trio → serif line; template cards with Start; sessions
  unchanged structurally, restyled.
- **Goals:** eyebrow headers, rectangular filter chips, serif completion
  check, hairline rows, no pill flood (category as small colored dot + text).
- **Journal:** timeline with hairlines, serif entry titles, no emoji pills.
- **Photos:** grid 6px tiles, ember "New photo" button, viewer unchanged.
- **History:** calendar kept (it is already good), ember today marker,
  serif streak number, category tints only in dots.
- **Achievements:** brass badge art on paper cards, serif unlock panel.
- **Notifications/Settings:** settings groups stay cards; rows lose pill
  icons; toggles restyled square-ish (track 999→10px? — prototype keeps
  track rounded for usability: 10px).
- **Avatar:** circle grid kept, ember selection ring, no glow.
- **Bottom nav:** full-width flat bar, ember underline active state.

## DESIGN TRADEOFFS

1. **Serif for numbers** — unusual in fitness apps; chosen for identity. Risk:
   perceived "slower" numerals; mitigated with tabular figures.
2. **Ember-on-done only** — big departure from teal-everywhere. Risk: screens
   look less "colorful"; that is the point, but it must be validated.
3. **No glass anywhere** — loses the "premium blur" trick; premium now comes
   from spacing, type and restraint.
4. **Dock removal** — loses a (working, tested) gesture; owner liked clever
   interactions in V1.1; this is a deliberate regression of flash for calm.
5. **Pill abolition** — status becomes text; slightly taller rows possible;
   wins simplicity.
6. **Prototype uses Georgia** instead of a licensed webfont — honest fidelity
   for shape/rhythm; real pairing (Fraunces) needs owner approval (Q2).

## QUESTIONS FOR OWNER REVIEW

- **Q1 — Identity:** Does "The Paper Log" direction feel right before any
  further screen detail work?
- **Q2 — Fonts:** Approve Fraunces + Inter (self-hosted, ~60KB woff2) or keep
  system fonts with serif-from-stack fallback?
- **Q3 — Accent:** Ember orange as the single "done" color — approve hue
  (`#c05f1e` light / `#e8863a` dark) or adjust?
- **Q4 — Dock:** Confirm removing the floating dock + drag gesture entirely.
- **Q5 — Dark default:** Keep dark as default (proposed: yes) or flip to
  paper-light default?
- **Q6 — Launch:** Keep the daily launch quote moment (simplified) or remove
  the launch screen entirely?
- **Q7 — Categories:** Approve the four category tints (water blue-gray, gym
  clay, goals olive, journal sand) used only in data graphics?
- **Q8 — Scope:** Approve implementation plan split (tokens → chrome →
  screens → motion) with QA after each step?

---
PRODUCTION IMPLEMENTATION: NOT DONE · PROTOTYPE/DESIGN ONLY · DEPLOYED: NO
