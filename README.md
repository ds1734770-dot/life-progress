# Life Progress

**Your personal life, fitness, goals and journal dashboard.**

A premium, offline-first mobile web app (PWA) that brings water tracking, gym
progress + progress photos, today/week/month/custom goals, a private journal
and a motivational dashboard into one cohesive experience.

> **Track → Understand → Improve**

---

## Quick start

```bash
npm start          # serve the app at http://localhost:8080
npm test           # run the Node unit tests
npm run smoke      # run the full end-to-end browser test (headless Chrome)
npm run qa         # extended QA: restart persistence, export/import, offline, mobile
npm run icons      # regenerate the PWA icons
npm run screenshots # capture screenshots of every screen (dark + light)
```

Open `http://localhost:8080` on a phone browser (or the Chrome device
toolbar). From the browser menu you can **Add to Home Screen** — the app then
launches full-screen like a native app and works fully offline.

---

## Technology decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Platform | **Mobile-first PWA** (no native SDK) | Free, installable, works on every phone, no app store, verifiable in CI. |
| Framework | **Vanilla ES modules** | Zero runtime dependencies; every byte is ours. |
| Storage | **IndexedDB** (single local DB) | Offline-first, handles hundreds of photos/entries, private by default. |
| Styling | **Hand-built design system** (CSS custom properties) | Consistent tokens for color/type/space/radius/motion; dark & light themes. |
| Icons | **Inline SVG** | Crisp at any size, no icon-font dependency. |
| Icons (PWA) | **Generated PNGs** (`node scripts/make-icons.js`) | Real 192/512 icons written with Node's built-in zlib — no asset toolchain. |
| Charts | **Pure CSS/SVG** | 7-day water bars and weekly volume need nothing heavier. |
| Offline | **Service worker** (cache-first app shell) | Core functionality works with no network. |
| Sync | **None (by design)** | The storage layer is a single module (`js/db.js`); swapping in a cloud adapter later means replacing just that file. |

The repository was empty when this project started, so the stack was chosen
for this environment: no Android SDK / Flutter toolchain is available, and the
requirements demand free-first + offline-first + installable. A PWA is the
most practical solution that satisfies all of them while remaining verifiable
end-to-end here.

---

## Features

- **Dashboard** — time-aware greeting, inspirational background (any image
  from your gallery), daily quote, animated overall daily progress ring, quick
  actions, and summary cards for goals, water, gym and journal.
- **Water** — quick-add (100/250/500/750 ml + custom), configurable daily
  target, animated progress ring, 7-day chart, recent entries with correction,
  average intake, on-target days and streak.
- **Gym** — workout logging (date, type, duration, notes), exercises with
  sets/reps/weight, expandable history, weekly volume chart, personal bests,
  stats (streak, total, this week/month).
- **Progress photos** — camera or gallery capture (native picker), automatic
  downscaling + thumbnails, date/label/notes, grid timeline, full-view modal,
  delete, and a **draggable before/after comparison**.
- **Goals** — Today / Week / Month / Custom buckets, categories, priorities,
  deadlines with overdue detection, pending/completed filters, completion
  animation, stats and goal streak. Daily goals reset each morning and keep
  their streak.
- **Journal** — distraction-free editor with mood + tags, searchable timeline
  grouped by day, streak/total/month stats, edit & delete.
- **Settings** — light/dark/system theme, name, background, water target +
  unit, per-feature preferences, **JSON export/import**, and confirmed
  full-data wipe.
- **Onboarding** — short 5-step first-launch flow (name, water target, theme,
  background).
- **Empty, loading, error & permission states** everywhere that matters —
  permission is requested only when the user actually uses camera/gallery.

---

## Architecture

```
index.html                 App shell (screen root, tab bar, modal/toast/onboarding roots)
manifest.webmanifest       PWA manifest
sw.js                      Service worker (offline app shell)
server.js                  Zero-dependency static server (dev)
css/
  theme.css                Design tokens (dark + light themes)
  base.css                 Reset, typography, app frame, keyframes
  components.css           Buttons, cards, inputs, rings, tab bar, modals, charts…
  screens.css              Per-screen layout
js/
  utils.js                 Pure helpers: local-timezone dates, streaks, daily
                           progress calculation, formatting  ← unit-tested
  models.js                Entity factories + validation (goals, workouts, …)
  db.js                    IndexedDB wrapper — the ONLY place that touches storage
  settings.js              App settings cache + theme resolution
  water.js / goals.js / gym.js / photos.js / journal.js
                           Domain logic per feature (queries, stats, streaks)
  ui.js                    DOM helpers, icon set, toast, sheets/dialogs, haptics,
                           counters/rings, event delegation, image picking
  router.js                Hash router + bottom navigation
  onboarding.js            5-step first-launch flow
  app.js                   Bootstrap: settings → tab bar → onboarding → route → SW
  screens/                 One module per screen (dashboard, water, goals, gym,
                           photos [+ compare], journal [+ editor], settings)
scripts/
  make-icons.js            Generates icons/*.png with Node's zlib
  smoke-test.js            End-to-end CDP test driving real Chrome
  qa-extended.js           Extended QA (persistence, export/import, offline, mobile)
  screenshots.js           Captures dark/light screenshots of every screen
test/
  utils.test.js            Node unit tests for dates, streaks, progress, formatting
```

**Layering:** screens → domain modules → storage. Screens never touch
IndexedDB directly; domain logic never touches the DOM. This is what makes
the eventual cloud-sync swap a one-file change.

---

## Key business logic

### Daily progress calculation (`js/utils.js`)

A weighted combination of four components, each a fraction `0..1`:

| Component | Weight | Value |
| --- | --- | --- |
| Goals | 40% | completed today's goals ÷ today's goals |
| Water | 30% | today's intake ÷ daily target |
| Gym | 15% | did a workout today ? 1 : 0 |
| Journal | 15% | wrote a journal entry today ? 1 : 0 |

Inactive components (e.g. no goals defined today) are removed from **both**
the numerator and denominator, so a quiet day never unfairly drags the score
down. The weights are a single exported constant — `PROGRESS_WEIGHTS` — so
tuning or adding components requires no UI changes.

### Streaks (`js/utils.js`)

A streak counts consecutive days with the activity, where the most recent day
is **today or yesterday** (so a user who hasn't acted *yet today* keeps their
streak). Days are de-duplicated (multiple entries per day count once), gaps
break the streak, and all arithmetic is pure local-date math, so week and
month boundaries are handled correctly. Water streak = days at/above target;
gym = days with a workout; journal = days with an entry; goals = days with at
least one completed goal. Daily goals track completion **per day**, so they
reset every morning without losing their history.

---

## Privacy

- Everything lives in **IndexedDB on this device**. Journal entries and
  photos are never uploaded anywhere.
- Photos are downscaled and re-encoded locally before storage; grids render
  thumbnails, and object URLs are revoked on screen change.
- No analytics, no telemetry, no accounts, no network requests beyond the
  app's own static files.
- Export/import are local JSON files; "Clear all data" requires confirmation.

---

## Backup & export

1. Open **Settings → Data → Export data** — a full JSON backup (all goals,
   workouts, water history, journal entries, photos **including image data**,
   and settings) is downloaded to your device.
2. To restore: **Settings → Data → Import data** and pick the backup file.
   Importing **replaces** everything currently on the device (you'll be asked
   to confirm first).
3. Keep the exported file somewhere safe — cloud drive, SD card, computer.
   The backup is a plain JSON file you can read anywhere; your data never
   touches any server during export or import.

## PWA installation

**Android (Chrome):** open the site → menu ⋮ → *Add to Home screen* →
Install. The app launches full-screen, standalone, and works offline.

**iOS (Safari):** open the site → Share → *Add to Home Screen*. (iOS uses
the `apple-touch-icon` and `apple-mobile-web-app-*` meta tags that ship in
`index.html`.)

**Desktop (Chrome/Edge):** an install icon appears in the address bar.

Installation requires **HTTPS** (or localhost). The app must be served as
static files — any static host works, see below.

## Deployment

The app is a **fully static site** — no build step, no server code required.
All asset paths are relative, so it deploys unchanged at a domain root
**or** under a subpath (e.g. `https://user.github.io/repo/`).

Requirements for the host:

- Serve `index.html` for `/`
- Serve all files with correct MIME types (`.js` as `text/javascript`,
  `.webmanifest` as `application/manifest+json`, `.png` as `image/png`)
- HTTPS (required for service worker + install prompt)
- No build step needed — upload the repository contents as-is
  (`.nojekyll` is included so GitHub Pages serves everything untouched)

Deploy targets that work out of the box: **GitHub Pages**, Netlify,
Cloudflare Pages, Vercel, Firebase Hosting, or any static web server.

After deploying an update, the service worker cache version in `sw.js`
(`life-progress-v1.1`) should be bumped so installed clients pick up the
new assets.

## Testing

- **Unit** (`npm test`): 44 tests covering date helpers, streak edge cases
  (gaps, duplicates, month boundaries, daily-goal reset), the weighted
  progress calculation, water math, per-day goal semantics and formatting.
- **End-to-end** (`npm run smoke`): drives the real app in headless Chrome
  over CDP (Node's built-in WebSocket, no dependencies) through the entire
  journey: onboarding → dashboard → add water → create & complete a goal →
  log a workout → upload a real photo through the file picker → write a
  journal entry → settings → **reload and verify persistence**. It also
  asserts zero unhandled JS errors. Runs against a fresh browser profile
  every time.
- **Extended QA** (`npm run qa`): persistence across a full browser restart,
  export → wipe → import round-trip (photo blobs included), offline mode with
  the server down, mobile overflow checks at 360/320px, PWA asset checks and
  a privacy scan of console output.
- Screenshots (`npm run screenshots`) are written to `screenshots/`.

---

## Known limitations / future work

- Notifications (daily reminders) are not implemented — permission flow is
  designed but the feature was intentionally left out until requested.
- Cloud sync can be added by implementing the same interface `js/db.js`
  exposes against a remote service.
- PWA install prompt requires a served (https or localhost) origin and a
  fresh install; the app remains fully functional in a browser tab.

## V1 status

**V1 — READY FOR PERSONAL USE.** The UI and feature set are frozen for V1.

Quality gate (all verified on the current commit):

- `npm test` — 44/44 passing
- `npm run smoke` — passing and repeatable (fresh profile per run)
- `npm run qa` — 52/52 extended checks passing
- `npm run screenshots` / `npm run icons` — passing
- Offline startup, restart persistence, export/import, mobile layout and
  service-worker caching all verified in headless Chrome
