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

- **Motivational launch (V1.1)** — a short, cinematic opening ritual: your
  Dashboard background fills the screen while your personal quote animates in
  (2–4 s, skippable, reduced-motion aware, never blocks the app). The quote
  defaults to *“Don't forget why u started.”* and is editable in Settings →
  Personalization with a live preview on your own background.
- **Avatar (V1.1)** — pick a locally bundled illustrated avatar, use your
  initials, or choose a photo from your gallery (downscaled to 256 px and
  stored only on this device). Shown beside your Dashboard greeting and in
  Settings; included in export/import.
- **Dashboard** — time-aware greeting with your avatar, inspirational
  background (any image from your gallery), daily quote, animated overall
  daily progress ring, quick actions, and summary cards for goals, water, gym
  and journal.
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
  unit, per-feature preferences, **notifications (V1.5)**, **JSON export/import**,
  and confirmed full-data wipe.
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
  notifications.js         V1.5: local reminder engine — prefs, permission,
                           context-aware eligibility, quiet hours, dedup,
                           payload/deep-link creation (pure, unit-tested)
  personalization.js       V1.1: launch quote + avatar helpers (pure, unit-tested)
  launch.js                V1.1: cinematic motivational launch overlay
  water.js / goals.js / gym.js / photos.js / journal.js
                           Domain logic per feature (queries, stats, streaks)
  ui.js                    DOM helpers, icon set, toast, sheets/dialogs, haptics,
                           counters/rings, event delegation, image picking
  router.js                Hash router + bottom navigation
  onboarding.js            5-step first-launch flow
  app.js                   Bootstrap: settings → launch ritual → tab bar →
                           onboarding → route → SW
  screens/                 One module per screen (dashboard, water, goals, gym,
                           photos [+ compare], journal [+ editor], settings,
                           notifications settings, avatar)
assets/
  launch-bg.png            Bundled fallback launch background (generated by
                           scripts/make-launch-bg.js — works offline)
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
(`life-progress-v1.2`) should be bumped so installed clients pick up the
new assets.

## Testing

- **Unit** (`npm test`): 254 tests covering date helpers, streak edge cases
  (gaps, duplicates, month boundaries, daily-goal reset), the weighted
  progress calculation, water math, per-day goal semantics and formatting,
  quote sanitization, initials and avatar normalization, pose/coordinate
  suites and the V1.4 gym domain (template CRUD semantics, pre-fill from last
  workout, session mutations, completion, PR detection, wipe safety).
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
- **V1.1 QA** (`npm run qa:v11`): 78 checks for the new features — launch
  overlay (first/subsequent launch, exact default quote, Dashboard-background
  relationship, bundled fallback, skip, auto-dismiss failsafe, no replay
  during navigation, reduced motion, offline), quote editor (counter, live
  preview, persistence, reset), avatar flows (built-in grid, initials, real
  gallery pick, Dashboard/Settings integration, blob persistence),
  export/import of personalization, full-restart persistence and overflow at
  320/360/390/412px.
- **Smart camera QA** (`npm run qa:camera`): 88 checks for the reference-aware
  progress camera — template analysis (on-device, metadata-only profiles),
  live camera + ghost overlay + skeleton, guidance/meter/stability/auto
  capture, the saved crop matching the aligned composition, lifecycle (tracks
  stopped, detector paused, 10 open/close cycles), the model-missing and
  permission-denied fallbacks, export/wipe/import of profiles, orphan pruning,
  the **real vendored model** initialising and inferring on-device, offline
  (server down, app shell from cache), reduced motion, accessibility and
  320–1024px layouts in both themes.
- **Notifications QA** (`npm run qa:notif`): real-browser checks for the V1.5
  notification foundation — settings section render + toggles, permission
  asked only from the user's action (never at startup), water eligibility
  driven by REAL data (target met ⇒ silent, unmet ⇒ eligible), dedup across
  repeated sweeps and reload, quiet-hours gating, achievement notification
  once-only contract, export/import of prefs, wipe clearing prefs + dedup
  state, service-worker notificationclick deep-link handler, 320–1024px
  overflow, light theme, reduced motion and zero console errors.
- **Gym templates QA** (`npm run qa:gym`): real-browser checks for the V1.4
  gym redesign — template-first home + honest empty state, create/edit/rename/
  duplicate/delete flows with the exercise library, session pre-fill from last
  workout (history never mutated), set-based logging (steppers, tap-to-complete,
  add/remove set, add/remove exercise mid-session), reload resume from the
  active-workout record, completion summary with PR detection, streak/achievement
  continuity, template deletion preserving history, export/wipe/import of the
  new stores, 320–1024px overflow, light theme, reduced motion and zero console
  errors. V1.4.1 adds: directly typed weight/reps (including decimals like
  62.5, cleared and re-typed values), per-set Remove with guarded confirmation,
  correct renumbering and value preservation after deletion, the min-1-set
  rule, and the full custom-exercise journey — create from the picker,
  duplicate-name reuse (case-insensitive), persistence across reload,
  search discovery, session/template integration and pre-fill from history.
- Screenshots (`npm run screenshots`, `npm run screenshots:camera`) are written
  to `screenshots/`.

---

## V1.5 status

**V1.5 — notification foundation + local reminders (additive).** A personal
consistency layer that helps the user show up — never a notification-spam
system. Every reminder must pass an "is this actually useful right now?"
gate before it is allowed to appear.

- **Architecture** (`js/notifications.js`): settings UI → notification domain
  → eligibility engine → Notification API / service worker. Eligibility is
  always DERIVED from the authoritative activity stores (water entries, gym
  workouts, goals, journal, streaks) — nothing is duplicated into a second
  database. The `notificationState` store (DB v5, additive) holds only
  preferences (singleton `prefs`) and per-reminder dedup records.
- **Permission**: requested ONLY from an explicit user action (enabling the
  master toggle or sending the test notification) — never at startup. Denied
  permission shows a calm explanation instead of re-prompting. States:
  unsupported / default / granted / denied.
- **Categories**: water, gym, goals, journal, streaks, achievements — each
  independently toggleable; the four daily ones have configurable local-clock
  reminder times ("11:00", not timezone-dependent UTC).
- **Quiet hours**: global window (default 22:30–07:00), midnight-crossing
  ranges supported, boundary semantics explicit (start inclusive, end
  exclusive), start === end disables.
- **Context-aware suppression**: water target met ⇒ silent; no water target
  ⇒ silent; workout today or < 3 rest days ⇒ silent; never trained ⇒ silent;
  journal entry exists ⇒ silent; no pending goals ⇒ silent; streak safe
  (today's action done) ⇒ silent; no live streak ⇒ never fabricated.
- **Dedup**: a reminder for a logical period can only be delivered once —
  delivery markers are written only AFTER a real display, so reloads, repeated
  sweeps, double engine initialization or a service-worker restart can never
  duplicate a notification. Records older than 30 days are pruned.
- **Achievements**: the existing celebration stays authoritative; a system
  notification is an additional entry point, deduped per achievement (once,
  ever).
- **Service worker**: `notificationclick` focuses a running app and navigates
  via the SAME hash routes the in-app router uses (water → #/water, gym →
  #/gym, goals → #/goals, journal → #/journal, achievements → #/achievements);
  with no window open it deep-links directly. Cache version bumped; existing
  offline strategy untouched.
- **Local-first**: no push server, no Firebase/OneSignal, no analytics, no
  external APIs. Reminder content is generated on-device from local data;
  journal content is NEVER included in any notification payload.

**Platform limitation (documented honestly):** without a Web Push
subscription, browsers cannot reliably schedule background notifications —
local reminders therefore evaluate when the app is opened/foregrounded (boot,
`visibilitychange`, and a light 15-minute interval while the page is open).
If the app stays closed all day, no reminder can fire; this is exactly what a
future Web Push phase will add, using the same payload/dedup/domain shape
already in place.

Quality gate (all verified on the current commit):

- `npm test` — 301/301 passing (31 new notification-domain tests)
- `npm run qa:notif` — 33/33 checks passing (real browser)
- all pre-existing suites keep passing (smoke, qa, v1.1, v1.2 ×2, gym)

---

## V1.4 status

**V1.4 — gym templates + set-based workout sessions (additive).** The gym
recedes from "fill out a form" to "choose the workout I'm doing today":

- **Workout templates** (`js/gymTemplates.js`, stores `workoutTemplates`,
  `exerciseLibrary`, `activeWorkout` — DB v4, purely additive). A template is a
  reusable plan ("Push Day"); only completed sessions become historical
  workouts and feed streaks, achievements, history and the dashboard.
- **Pre-fill from last workout** — every exercise in a new session starts from
  its most recent recorded performance (§9); historical workouts are never
  mutated, and the empty-workout flow (`#/gym/new`, dashboard quick action)
  remains available.
- **Set-based logging** — per-set weight/reps with both steppers and directly
  editable numeric inputs (`inputmode="decimal"` for weight, integer for reps;
  0.5 kg precision preserved), persisted to the active workout on edit so
  values survive navigation and reload, tap-to-complete with reduced motion
  support, add/remove sets (guarded confirmation, min-1 rule, renumbering)
  and exercises for TODAY only (skipping an exercise never edits the
  template), rest timer (optional, dismissible), beat-last-time pills and
  honest PR detection (strict improvement over real history; first-ever
  performances set the baseline, they don't invent PRs).
- **Resume** — unfinished sessions persist in the active-workout record and
  survive reload/offline; the gym home shows a WELCOME BACK banner with a
  guarded Discard action.
- **Templates are not history** — deleting a template never deletes the
  workouts performed with it; editing a template only affects future sessions.
- **Migration aid** — any completed workout can be saved as a template from
  the session summary (SAVE AS TEMPLATE).

**V1.4.1 — session polish (additive).** Two usability fixes on top of V1.4:

- **Editable set values** — the weight and reps in every set row are real
  numeric inputs (steppers remain). Weight accepts decimals down to 0.5 kg
  precision; reps are positive integers. Edits update the in-memory session
  immediately and persist to the active-workout record on input/blur, so a
  half-typed value survives navigation and reload without waiting for
  completion. Invalid input never crashes: empty cells keep the previous
  value, negatives are clamped.
- **Set deletion** — each set has a guarded Remove action (confirmation
  dialog, no browser `alert()`). Deleting removes only that set, renumbers
  the remaining rows and keeps their values/completion state; the last
  remaining set cannot be deleted (use the existing exercise removal
  instead). Historical workouts are never touched.
- **User-created exercises** — both exercise pickers (mid-session and
  template editor) end with a CREATE NEW EXERCISE action: name + optional
  muscle group, saved into the existing `exerciseLibrary` store as a
  first-class exercise. Custom exercises participate in search, templates,
  sessions, pre-fill, history, PRs, export/import and wipe exactly like
  predefined ones; duplicate names (case-insensitive) reuse the existing
  record instead of creating a second one.

Quality gate (all verified on the current commit):

- `npm test` — 301/301 passing (adds the V1.4 template/session domain suite,
  the V1.4.1 typed-input/set-deletion/custom-exercise suites and the V1.5
  notification domain suite)
- `npm run smoke` — passing
- `npm run qa`, `npm run qa:v11`, `npm run qa:v12:phase1`, `npm run qa:v12:phase2` — passing
- `npm run qa:notif` — 33/33 notification checks passing
- `npm run qa:gym` — 92/92 gym redesign + polish checks passing
- `npm run smoke` — passing
- `npm run qa`, `npm run qa:v11`, `npm run qa:v12:phase1`, `npm run qa:v12:phase2` — passing
- `npm run qa:gym` — 92/92 gym redesign + polish checks passing
- `npm run qa:camera` — pre-existing headless mediapipe flake on this machine
  (fails identically on the clean tree); all camera checks pass on hardware
- `npm run screenshots` — 20 gym-state captures (V1.4 + V1.4.1 typed inputs,
  set deletion, custom-exercise flows) alongside the existing set

---

## V1.3 status

**V1.3 — reference-aware smart progress camera (additive).** Progress photos,
history, comparison, achievements and export/import behave exactly as before;
the smart camera is an optional enhancement on top of the existing capture path.

How it works:

- **Photo template** — any existing progress photo can become the active
  template. Its pose is analysed *on device* and stored as a compact,
  versioned metadata profile (`js/pose/reference.js`, IndexedDB store
  `photoReferences`). The photo itself stays the single authoritative record:
  no copy, no re-encode, no extra bytes.
- **Alignment** — `js/pose/alignment.js` compares the live pose with the
  profile in ONE canonical composition space (`js/camera/coordinates.js`)
  across position, scale/distance, framing, posture and head, using weighted,
  confidence-aware scoring. It returns one prioritised instruction at a time
  (no person → framing → distance → position → posture → stability → capture)
  with hysteresis so guidance never flickers.
- **Camera** — `js/screens/camera.js` shows the live preview with the previous
  photo as a **ghost** overlay (Ghost / Outline / Off) and both skeletons,
  adapts inference cadence to the device, requires ~1s of stable alignment
  before the countdown, and always allows manual capture. The saved photo is
  cropped to exactly the composition the user aligned to.
- **Privacy/offline** — the runtime (`vendor/mediapipe/`) is self-hosted and
  the pinned bundle contains no external URLs or telemetry; camera frames,
  photos and landmarks never leave the device. Nothing loads until the smart
  camera is opened, and after the first use the feature works offline from the
  service-worker cache.
- **Fallback** — unsupported browser, missing model, failed init, no camera or
  denied permission all degrade to the existing standard capture path.

Quality gate (all verified on the current commit):

- `npm test` — 225/225 passing (includes 4 new pose/coordinate suites)
- `npm run smoke` — passing
- `npm run qa` — all extended checks passing
- `npm run qa:v11`, `npm run qa:v12:phase1`, `npm run qa:v12:phase2` — passing
- `npm run qa:camera` — 88/88 smart camera checks passing
- `npm run screenshots:camera` — 10 camera screenshots (states, themes, 320/768px)

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

## V1.1 status

**V1.1 — motivational launch + avatar personalization added; V1 UI and data
untouched.** New settings fields (`launchQuote`, `avatar`, `avatarImage`) are
merged onto existing records at load, so V1 users get the default quote and
avatar automatically — no migration, no reinstall, no data loss.

Quality gate (all verified on the current commit):

- `npm test` — 57/57 passing (44 V1 + 13 V1.1)
- `npm run smoke` — passing and repeatable (fresh profile per run)
- `npm run qa` — 52/52 extended checks passing
- `npm run qa:v11` — 78/78 V1.1 checks passing
- `npm run screenshots` / `npm run icons` / `npm run launch-bg` — passing
- Launch experience, avatars, quote editing, export/import, offline launch,
  reduced-motion and 320–412px layouts all verified in headless Chrome

## V1 status

**V1 — READY FOR PERSONAL USE.** The UI and feature set are frozen for V1.

Quality gate (all verified on the current commit):
