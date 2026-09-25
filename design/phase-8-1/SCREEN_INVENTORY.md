# SCREEN INVENTORY — PHASE 8.1

Legend — Confidence: H/M/L. Impact: S/M/L lines of production change.
Prototype: `prototypes/index.html` (screens via bottom-nav + in-screen links).

| # | Screen | Current problems | Proposed redesign | Prototype location | Implementation impact | Conf. | Open questions |
|---|--------|------------------|-------------------|--------------------|-----------------------|-------|----------------|
| 1 | Launch | Ken Burns blur-in, 5-element choreography, serif only here | Flat photo/ink, serif quote, 2.2s auto or tap, 250ms fade exit | `#/launch` (intro view) | M — `js/launch.js` + `launch-*` CSS | H | Q6 keep at all? |
| 2 | Dashboard | 6 stacked cards, quote block, buried ring, "Your Journey" nav-card | Day Record header (date, completion line) + Today ring card + 4 log rows + header nav | `#/dashboard` | L | H | none |
| 3 | Water | Ring 136px w/ small number, pill flood, chips | Serif 44px ring number, quick-add rect buttons, water-tint bars, hairline list | `#/water` | S | H | none |
| 4 | Gym | Stat boxes, pill flood, template cards | Serif stat line, 10px template cards w/ Start, resume kept, PB hairline rows | `#/gym` | M | H | none |
| 5 | Goals | 3 pills/card, seg+chips double filter | Eyebrow headers, single filter row, dot+text categories, serif check | `#/goals` | S | H | none |
| 6 | Journal | Emoji pill mood, card-per-entry | Hairline timeline, serif titles, mood as text, editor keeps calm (italic) | `#/journal` | S | H | none |
| 7 | Photos | 16px tiles, blur labels | 6px tiles, no blur, ember New Photo | `#/photos` | S | H | none |
| 8 | Smart Camera | Restyle only — functional screen | 6px stage radius, ember shutter ring, same guidance/meter | (doc only; not in prototype) | S | M | device QA later |
| 9 | History | Good bones; accent overload, streak glow | Ember today ring, serif streak numeral, tint dots only, flat chips | `#/history` (via Dashboard) | S | H | none |
| 10 | Achievements | Glow badges, gradient panel | Brass badge art, paper cards, serif unlock panel | `#/achievements` (via Dashboard) | M | M | Q3 accent tier colors? |
| 11 | Notifications | Settings section, switches | Same structure; ink toggles, no colored row icons | (part of Settings) | S | H | none |
| 12 | Settings | Colored icon boxes, pill rows | Neutral rows, hairline groups, danger as outline text | `#/settings` | S | H | none |
| 13 | Avatar | Glow selection ring | Ember ring, no glow, rest of flow unchanged | (sheet in prototype: Dashboard → avatar) | S | H | none |
| 14 | Bottom nav | Floating glass capsule + drag + slide | Flat full-width bar, ember underline, no drag | every view (fixed) | M — `tabbar-dock.js` mostly deleted | H | Q4 confirm |

Implementation impact assumes token-level change happens first
(`css/theme.css` rewrite) which carries ~60% of the visual change alone.
