# PHASE 8.1 — VISUAL + INTERACTION REDESIGN (DESIGN ARTIFACT)

**Status: PROTOTYPE/DESIGN ONLY — NOT IMPLEMENTED — NOT APPROVED YET.**

This folder is the complete Phase 8.1 deliverable: audit, direction, system,
a clickable high-fidelity prototype, and review documents. Nothing here is
imported by the production app (verify: `git status` — only new files under
`design/`).

## Contents

| File | What it is |
|---|---|
| `README.md` | this file + how to view the prototype |
| `design-audit.md` | read-only audit of the CURRENT UI |
| `design-system.md` | proposed "Paper Log" design system (colors, type, shape, motion) |
| `DESIGN_REVIEW.md` | owner-facing review doc: problems → proposal → tradeoffs → questions |
| `SCREEN_INVENTORY.md` | per-screen: problems → redesign → impact → confidence |
| `prototypes/index.html` | **the clickable high-fidelity prototype** (self-contained, own CSS/JS, demo data) |
| `screenshots/` | rendered screenshots of every prototype view |

## How to view the prototype

No build, no server, no dependencies:

- Double-click `prototypes/index.html`, or
- `npx serve design/phase-8-1/prototypes` (or any static server), or
- `node server.js` then open `http://localhost:8080/design/phase-8-1/prototypes/`
  (the production static server also serves the folder — production files are
  not touched by this).

A "PROTOTYPE" ribbon stays visible in the prototype header at all times so it
can never be mistaken for the production app.

## Prototype tour

1. Launch view plays on open (skip via tap).
2. Bottom nav: Dashboard · Water · Gym · Goals · Journal · Settings.
3. Dashboard: completion ring animates; "History" and "Achievements" open
   those views; avatar opens the avatar picker sheet (representative modal).
4. Water: quick-add buttons actually fill the ring/bar (prototype state only).
5. Goals: check one off → completion moment (check draw + soft pulse + toast).
6. History: switch months, tap a day.
7. Achievements: tap a badge → unlock panel (representative celebration).
8. Settings: theme toggle switches Paper (light) / Ink (dark) live.

All data is demo data, clearly labeled, stored only in page memory.

## Approval gate

Nothing here may be merged into production without explicit owner approval.
Next stage after approval: implementation plan → phased production change →
QA → review.
