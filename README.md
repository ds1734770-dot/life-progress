# Life Progress

**Your personal life, fitness, goals and journal dashboard.**

A premium, offline-first mobile web app (PWA) that brings water tracking, gym
progress + progress photos, today/week/month/custom goals, a private journal
and a motivational dashboard into one cohesive experience.

> **Track → Understand → Improve**

---

## Quick start

```bash
npm start          # serve the app + notification backend at http://localhost:8080
npm test           # run the Node unit tests (344)
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
| Reminders | **Web Push + server scheduler (V1.6)** | True background delivery with the app closed; see *Notifications (V1.6)* below. |
| Sync | **None (by design)** | Personal data stays local; the push server stores delivery metadata only. |

---

## Notifications (V1.6) — real background reminders

### Why local timers cannot do this

Browsers throttle or suspend JavaScript in background/closed tabs. A
`setTimeout`/`setInterval` inside the page dies with the tab, so any reminder
built on page timers can only appear when the user reopens the app. The Web
Push model exists precisely for this: a **server** sends a signed,
encrypted message to the **browser's push service** (FCM on Android/Chrome,
Apple's service on iOS 16.4+, Mozilla's on Firefox), which **wakes the
service worker** even with the app fully closed. The SW then calls
`showNotification` — the OS displays it. No page JavaScript is involved.

### How it works in Life Progress

```
User enables reminders (Settings → Notifications)
  → permission requested (explicit tap only)
  → PushManager.subscribe with the server's VAPID public key
  → subscription + schedule (times, timezone, quiet hours) → POST /api/push/register
  → server stores the record and computes the NEXT occurrence per category

At the scheduled wall-clock time in the DEVICE's timezone
  → server encrypts a minimal payload (RFC 8291) + signs VAPID (RFC 8292)
  → POST to the browser push service
  → service worker wakes (even if the app is closed)
  → SW validates the payload, re-checks prefs/quiet-hours/dedup LOCALLY,
    derives the context-aware copy from local data (same eligibility engine
    as the in-app sweep), then showNotification()
  → OS notification; tap deep-links to #/water #/gym #/goals #/journal …
```

**Privacy by construction:** the push payload contains only
`{ type, category, occurrenceId, dateKey, route, serverTime }` — never
journal text, amounts, names or photos. The context-aware wording ("1500 ml
left", "You have 2 goals left") is derived **on the device** from the local
IndexedDB. The server stores only: endpoint, crypto keys, timezone, reminder
times, quiet hours, category toggles and delivery bookkeeping.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | no | Listen port (default 8080). |
| `VAPID_PUBLIC_KEY` | prod: yes | Base64url P-256 public key (safe to expose). |
| `VAPID_PRIVATE_KEY` | prod: yes | Base64url PKCS#8 private key — **server only, never commit**. |
| `VAPID_SUBJECT` | prod: yes | `mailto:you@example.com` (or `https://…`) contact for VAPID JWTs. |
| `PUSH_VAPID_FILE` | no | Where auto-generated dev keys persist (default `.vapid-keys.json`, git-ignored). |
| `PUSH_DATA_FILE` | no | Scheduling-state file (default `.push-data.json`, git-ignored). |

If the VAPID env vars are absent (local dev), the server generates a keypair
once and persists it to `PUSH_VAPID_FILE`.

### Generating VAPID keys for production

```bash
node -e "import('./server/push/webpush.js').then(async m => { const k = await m.generateVapidKeys(); console.log('VAPID_PUBLIC_KEY=' + k.publicKey); console.log('VAPID_PRIVATE_KEY=' + k.privateKey); })"
```

Or simply let the server generate them once and copy the values out of the
key file.

### Running the notification server

- **Local:** `npm start` — static app + push API + scheduler in one process.
- **Split deployment:** host the static app anywhere (GitHub Pages/Netlify);
  run the scheduler on an always-on machine with `PUSH_WORKER_ONLY=1 node server.js`
  (or `node server/push-worker.js`) and point the client at it by defining
  `window.LIFE_PROGRESS_PUSH_API = "https://your-push-host"` before app.js
  loads. If unset, the client uses same-origin `/api/push/*`.

### Scheduling semantics

- Reminders are **daily recurring**; the server holds exactly **one pending
  occurrence** per category and advances it after handling (no infinite job
  lists).
- Occurrence identity is deterministic: `deviceKey:category:dateKey-in-user-tz`
  — the same date key the SW and page dedup against, so push and in-app
  sweeps can never double-deliver.
- **Restart-safe:** pending state is derived from the persisted subscription
  records (atomic JSON file); the ledger records the last handled occurrence
  per category. Restarting the server mid-day never re-delivers.
- **Missed reminders (§11):** an occurrence not delivered within a 90 s grace
  window (server down, etc.) is marked `missed` and **not** replayed — the
  next day's occurrence is scheduled instead. No stale floods after recovery.
- **Server downtime:** delivery resumes automatically; anything already past
  its window is skipped as missed.
- **Timezone correctness:** wall-clock times are materialized with `Intl`
  against the device's IANA zone each time — DST shifts, midnight,
  month/year boundaries and leap years all resolve correctly
  (`js/timeCore.js`, unit-tested against `America/New_York` transitions).
- **Timezone changes:** the client re-registers on sync with the device's
  current IANA zone, so travel re-anchors every reminder.

### Quiet hours

Evaluated **twice**: the server refuses to schedule pushes inside the
device's quiet window (suppress-forever, no replay — the next day's
occurrence continues), and the service worker re-checks the same window at
delivery time (device clock) as a second gate. Semantics are identical to
V1.5: `[start, end)`, midnight-crossing supported, `start === end` disables.

### Deduplication (§13)

Three layers share one identity space:

1. **Server ledger** — `claimOccurrence` is atomic; duplicate ticks,
   restarts or worker double-starts cannot send twice.
2. **Service worker** — validates `dateKey` and re-checks the same
   IndexedDB dedup records the page uses (`notificationState` store).
3. **In-app sweep** (kept as reconciliation, §32) — skips anything push
   already delivered. Opening the app can never duplicate a notification.

### Test notification

Settings → Notifications → **Send** now exercises the **real push path**
first: client → subscription → server → Web Push → service worker → OS.
It reports which path delivered (`push` vs local fallback) and fails loudly
when the push infrastructure is unavailable (e.g. server down).

### Unsupported platforms — honest behavior

The settings screen shows a delivery status row with explicit states:
**Background reminders active** / **Setting up background reminders…**
(server unreachable — reminder saved locally, syncs later) / **Notifications
are disabled** / **Background reminders aren't supported on this browser** /
**Needs a secure (https) connection** / **Couldn't activate background
reminders. Your reminder is saved locally.** Nothing ever fakes "active".

Platform notes:
- **Android/Chrome:** full background push (installed PWA or browser tab).
- **iOS/iPadOS 16.4+:** Web Push works for **Home Screen web apps** — add to
  Home Screen first, then enable notifications from the installed app. In
  regular Safari tabs iOS does not deliver background push; the UI shows the
  unsupported state rather than pretending.
- **Desktop Chrome/Edge/Firefox:** supported (delivery while the browser
  itself is running; OS-level rules apply once the browser quits).

### Local testing recipe (catches the original bug)

1. `npm start` → open `http://localhost:8080` (use a tunnel like
   `ngrok http 8080` to test a real phone).
2. Settings → Notifications → enable → grant permission → status shows
   **Background reminders active**.
3. Send the **test notification** — it must arrive through the push path.
4. Set a water reminder 2–5 minutes ahead.
5. **Completely close the app** (swipe away) and lock the screen.
6. At the scheduled minute the OS notification must arrive.
7. Tap it → Life Progress opens on the right screen.
8. Reopen the app: the same occurrence must **not** appear again.

### Security notes (§24)

- VAPID private key exists only server-side (env or 0600 key file); it is
  never served, logged or bundled.
- All registration input is validated (endpoint scheme, key lengths, IANA
  timezone, `HH:MM` times, category booleans); unknown fields are dropped.
- Push payload routes pass through an allowlist — no injection into
  navigation.
- Rate limits guard the API; request bodies are size-capped.
- Push endpoints/keys/timezones are the only stored data — nothing personal.

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
  unit, per-feature preferences, **notifications (V1.5 + V1.6 background
  push)**, **JSON export/import**, and confirmed full-data wipe.
- **Onboarding** — short 5-step first-launch flow (name, water target, theme,
  background).
- **Empty, loading, error & permission states** everywhere that matters —
  permission is requested only when the user actually uses camera/gallery.

---

## Architecture

```
index.html                 App shell (screen root, tab bar, modal/toast/onboarding roots)
manifest.webmanifest       PWA manifest
sw.js                      Service worker (offline shell + push event + deep links)
server.js                  Static server + push API + scheduler loop (dev)
server/
  api.js                   /api/push/* — subscription lifecycle (validated, rate-limited)
  scheduler.js             Background scheduler: occurrences, quiet hours, dedup, delivery
  store.js                 Atomic JSON persistence (subscriptions + delivery ledger)
  vapid.js                 VAPID credential loading (env → file → generated)
  push/webpush.js          RFC 8291 aes128gcm encryption + RFC 8292 VAPID (Node WebCrypto)
  push-worker.js           Standalone scheduler entry (split deployments)
css/
  theme.css                Design tokens (dark + light themes)
  base.css                 Reset, typography, app frame, keyframes
  components.css           Buttons, cards, inputs, rings, tab bar, modals, charts…
  screens.css              Per-screen layout
js/
  utils.js                 Pure helpers: local-timezone dates, streaks, progress  ← unit-tested
  timeCore.js              V1.6: shared time/IANA-timezone/quiet-hours core ← unit-tested
  models.js                Entity factories + validation (goals, workouts, …)
  db.js                    IndexedDB wrapper — the ONLY place that touches storage
  settings.js              App settings cache + theme resolution
  notifications.js         V1.5 notification domain — prefs, permission, eligibility,
                           dedup, payloads (+ V1.6 push-aware test notification)
  swPush.js                V1.6: SW push-handler logic (validated, gated, testable)
  pushClient.js            V1.6: subscription manager (capability, subscribe, sync, wipe)
  water.js / goals.js / gym.js / photos.js / journal.js
                           Domain logic per feature (queries, stats, streaks)
  ui.js                    DOM helpers, icon set, toast, sheets/dialogs, haptics,
                           counters/rings, event delegation, image picking
  router.js                Hash router + bottom navigation
  onboarding.js            5-step first-launch flow
  app.js                   Bootstrap: settings → launch ritual → tab bar →
                           onboarding → route → SW → push re-sync
  screens/                 One module per screen (dashboard, water, goals, gym,
                           photos [+ compare], journal [+ editor], settings,
                           notifications settings, avatar)
assets/
  launch-bg.png            Bundled fallback launch background
scripts/                   Smoke/QA/screenshot tooling
test/                      Node unit tests (incl. push-scheduling, push-sw, push-crypto)
```

**Layering:** screens → domain modules → storage. Screens never touch
IndexedDB directly; domain logic never touches the DOM. The push server is a
separate layer that never becomes the source of truth for personal data.

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

Inactive components are removed from **both** the numerator and denominator,
so a quiet day never unfairly drags the score down.

### Streaks (`js/utils.js`)

A streak counts consecutive days with the activity, where the most recent day
is **today or yesterday**. Days are de-duplicated, gaps break the streak, and
all arithmetic is pure local-date math.

---

## Privacy

- Everything personal lives in **IndexedDB on this device**. Journal entries
  and photos are never uploaded anywhere — including in push payloads.
- The push server stores only delivery metadata (see above).
- No analytics, no telemetry, no accounts, no third-party SDKs.
- Export/import are local JSON files; "Clear all data" requires confirmation
  and also removes the device's push registration.

## Backup & export

1. Open **Settings → Data → Export data** — a full JSON backup (all goals,
   workouts, water history, journal entries, photos **including image data**,
   settings and notification prefs) is downloaded to your device.
2. To restore: **Settings → Data → Import data** and pick the backup file.
   Importing **replaces** everything currently on the device; background
   delivery is re-registered to match the imported prefs.
3. The backup is a plain JSON file; your data never touches any server
   during export or import.

## PWA installation

**Android (Chrome):** open the site → menu ⋮ → *Add to Home screen* →
Install. The app launches full-screen, standalone, and works offline.

**iOS (Safari):** open the site → Share → *Add to Home Screen*. Push
notifications require the installed Home Screen app (iOS 16.4+).

**Desktop (Chrome/Edge):** an install icon appears in the address bar.

Installation and push require **HTTPS** (or localhost).

## Deployment

The app itself remains a **fully static site** (relative paths, deploys at a
domain root or subpath — GitHub Pages, Netlify, Cloudflare Pages, Vercel,
Firebase Hosting or any static server).

Background reminders additionally need the notification backend on an
always-on host:

```bash
VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:you@example.com \
PUSH_DATA_FILE=/var/data/life-progress/push.json \
node server.js          # or PUSH_WORKER_ONLY=1 for scheduler-only
```

- The scheduler is a **persistent worker process** (15 s tick, restart-safe).
  On a platform without long-running processes, run it on any always-on box
  (Raspberry Pi, home server, VPS) via systemd/PM2; the static app can stay
  on the static host and point at the worker through
  `window.LIFE_PROGRESS_PUSH_API`.
- State survives restarts in `PUSH_DATA_FILE`; the first tick after startup
  only handles occurrences inside the grace window (no stale flood).
- After deploying an update, bump the service worker cache version in `sw.js`
  (`life-progress-v1.12`).

## Testing

- **Unit** (`npm test`): 355 tests — the original 301 (dates, streaks,
  progress, gym, notification domain, pose/coordinates) **plus 54 new** for
  V1.6/V1.6.1: IANA timezone materialization (Kolkata, New York DST
  transitions, spring-forward gaps, midnight/month/year/leap-year
  boundaries), the delivery policy (grace window, missed-occurrence, quiet
  hours), the deterministic occurrence-id scheme, the minimal payload shape,
  the service worker push handler (gate order, cross-mechanism dedup, silent
  "not-useful-now", fallback copy, payload validation/route allowlist), the
  Web Push crypto (VAPID ES256 JWT verified independently, aes128gcm
  encrypt→decrypt round-trip, malformed-key rejection) and the V1.6.1
  capability suite (Chrome never "unsupported", iPhone Safari tab →
  install-required, iPadOS detection, insecure/missing-API states,
  capability-vs-readiness separation).
- **End-to-end** (`npm run smoke`): full app journey in headless Chrome.
- **Extended QA** (`npm run qa`): persistence, export→wipe→import round-trip,
  offline mode, mobile overflow, privacy scan.
- **Notifications QA** (`npm run qa:notif`): real-browser notification
  checks (settings render, permission from user action only, eligibility
  from real data, dedup across reloads, quiet hours, achievements wiring,
  export/import/wipe of notification state, responsive 320–1024 px, light
  theme, reduced motion, zero console errors).
- Real-device background-push QA: see the *Local testing recipe* above and
  run it on an Android phone (and an iOS 16.4+ Home Screen app) — closed app,
  locked screen, notification at the scheduled minute, tap → deep link, no
  duplicates on reopen.

---

## V1.6 status

**V1.6 — true background reminder delivery via Web Push (additive).** The
V1.5 local-first foundation, eligibility engine, quiet hours, dedup records,
deep links and wording are unchanged; only the delivery mechanism was
replaced:

- The app no longer relies on page timers for delivery. A server-side
  scheduler (own process, persisted state) computes the next occurrence per
  device/category in the device's IANA timezone and delivers via Web Push
  (RFC 8291 + RFC 8292, zero-dependency Node implementation).
- The existing service worker gained `push` + `pushsubscriptionchange`
  handlers (additive; offline strategy untouched, cache bumped to v1.12).
  Context-aware copy is derived locally at delivery time; the payload holds
  no personal data.
- The in-app sweep remains as reconciliation only — deduped against push
  through the same `notificationState` records.
- New client module `js/pushClient.js` owns capability detection, the
  permission/subscription flow, boot re-sync, `pending`/`error` states and
  wipe support; the settings screen shows the honest delivery status (§33).
- Test notification exercises the real push path and reports which path
  delivered.
- Export/import preserve notification prefs; import re-syncs the server;
  full wipe deregisters and unsubscribes the device.

**V1.6.1 — capability fix (same feature, corrected detection).** The
original V1.6 feature-detected the Push API with
`'PushManager' in ServiceWorkerRegistration.prototype` — but the prototype's
property is the camelCase accessor `pushManager`, so the check was false in
EVERY browser and both Chrome and iPhone were wrongly told "This browser
doesn't support background push." Fixed by checking the actual
registration-side accessor plus the constructor; capability (can this
browser ever push?) is now separated from setup readiness (which step is
next?), with these distinct states: browser unsupported / secure connection
required / **Home Screen installation required (iOS Safari tab)** /
permission required / service worker initializing / subscription required /
server registration pending / server unavailable / **background reminders
active**. A supported-but-not-enabled browser reads "Background reminders
are ready to set up" — never "unsupported". A Settings → Notifications →
Diagnostics row shows every observed stage per device (§29) without exposing
any credentials.

Quality gate (this tree): `npm test` 355/355 passing (301 pre-existing +
54 new), server API sanity verified live (vapid-public, register, invalid
rejection, status). Smoke/QA suites and real-device verification are run
per the recipe above before calling the feature done on hardware.

---

## V1.5 status

**V1.5 — notification foundation + local reminders (additive).** A personal
consistency layer that helps the user show up — never a notification-spam
system. Every reminder must pass an "is this actually useful right now?"
gate before it is allowed to appear.

- **Architecture** (`js/notifications.js`): settings UI → notification domain
  → eligibility engine → Notification API / service worker. Eligibility is
  always DERIVED from the authoritative activity stores. The
  `notificationState` store (DB v5, additive) holds only preferences
  (singleton `prefs`) and per-reminder dedup records.
- **Permission**: requested ONLY from an explicit user action. Denied
  permission shows a calm explanation instead of re-prompting.
- **Categories**: water, gym, goals, journal, streaks, achievements — each
  independently toggleable; the four daily ones have configurable
  local-clock reminder times.
- **Quiet hours**: global window (default 22:30–07:00), midnight-crossing,
  start inclusive / end exclusive, start === end disables.
- **Context-aware suppression**: water target met ⇒ silent; no water target
  ⇒ silent; workout today or < 3 rest days ⇒ silent; never trained ⇒ silent;
  journal entry exists ⇒ silent; no pending goals ⇒ silent; streak safe
  ⇒ silent; no live streak ⇒ never fabricated.
- **Dedup**: a reminder for a logical period can only be delivered once —
  delivery markers are written only AFTER a real display.
- **Achievements**: the existing celebration stays authoritative; a system
  notification is an additional entry point, deduped per achievement.
- **Deep links**: water → #/water, gym → #/gym, goals → #/goals, journal →
  #/journal, achievements → #/achievements.
- **Local-first**: reminder content is generated on-device from local data;
  journal content is NEVER included in any notification payload.

---

## V1.4 status

**V1.4 — gym templates + set-based workout sessions (additive).** Workout
templates (`js/gymTemplates.js`), pre-fill from last workout, set-based
logging with typed values, guarded set deletion, custom exercises, resume of
unfinished sessions. Historical workouts are never mutated; deleting a
template never deletes workouts.

## V1.3 status

**V1.3 — reference-aware smart progress camera (additive).** On-device pose
profiles (`js/pose/reference.js`), alignment scoring, ghost/outline overlay,
auto-capture, self-hosted vendored runtime, graceful fallback to the standard
capture path. Camera frames and photos never leave the device.

## Known limitations / future work

- Background push requires an always-on notification backend (see
  Deployment). Without it, reminders still work while the app is open, and
  the settings screen says so honestly.
- iOS delivers Web Push only to installed Home Screen web apps (16.4+).
- Desktop browsers stop delivering push when the browser application itself
  fully exits.
- Cloud sync can be added by implementing the same interface `js/db.js`
  exposes against a remote service.
