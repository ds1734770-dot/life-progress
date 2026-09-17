# Native App Migration — Architecture & Decision Record

**Status:** Phase 1 complete (scaffolding + platform abstraction). Native push (APNs/FCM) is **not** implemented yet.
**Started:** 2026-09-17 · Branch: `main`

---

## 1. Current architecture (unchanged, production)

```
Life Progress PWA (GitHub Pages, static ES modules)
        ↓ Web Push subscription (VAPID)
Cloudflare Worker  (cloudflare/worker.js — stateless API)
        ↓
Durable Object     (cloudflare/do.js — SQLite, LPPushDO)
        ↓
Self-rescheduling DO alarm (~1/min) — the production scheduler
        ↓
occurrence eligibility → quiet hours → atomic claim (occurrence_id PK)
        ↓
Web Push delivery  (server/push/webpush.js — RFC 8291/8292 WebCrypto)
        ↓
Service worker (sw.js) → js/swPush.js → OS notification
```

Shared runtime-neutral core: `server/push/domain.js` (occurrences, grace
window, quiet hours, minimal payload), `server/push/http.js` (CORS,
registration validation), `server/push/webpush.js` (isomorphic crypto).
Node backend (`server.js`, `server/`) remains the local-dev shape.

## 2. Target architecture

```
                         LIFE PROGRESS
                              |
                    Shared application
              (same ES modules, same IndexedDB)
                              |
              ┌───────────────┼───────────────┐
             WEB             IOS           ANDROID
              |               |               |
        PWA / Web Push   Capacitor+APNs  Capacitor+FCM
              └───────────────┼───────────────┘
                              |
                     Cloudflare Worker
                              |
                       Durable Object
                              |
                    Notification scheduler
              (alarm → occurrences → claims — unchanged)
                              |
                     Delivery dispatcher        ← later phase
                    /        |        \
               WebPush      APNs      FCM
```

One scheduler, one occurrence model, three transports. The scheduler never
learns platform specifics; a dispatcher chooses the provider per device.

## 3. Why Capacitor

Decided in the Implementation Readiness Report, re-verified against the repo:

- The app is **100% static ES modules with relative paths** (deployed at
  domain root or subpath today) — Capacitor's `webDir` model maps 1:1, no
  bundler needed or added.
- Screen → domain → storage layering is preserved; the same modules run in
  the WKWebView / Android WebView.
- Camera stack (`js/camera/*`, standard `getUserMedia` + `ImageCapture` +
  canvas) and MediaPipe assets are **vendored same-origin**
  (`vendor/mediapipe/`, WASM + `pose_landmarker_lite.task`), so they load
  from the local bundle; WebView WASM/SIMD is supported on iOS 15+ and
  modern Android WebView.
- Official `@capacitor/push-notifications` (later phase) exposes the APNs
  token on iOS and the FCM token on Android through one API — exactly the
  per-platform credential model the backend needs.
- Rejected: React Native / Flutter (full UI rewrite — violates the core
  mandate), TWA (no native FCM transport), hand-rolled WKWebView shells
  (reimplements Capacitor without the plugin ecosystem).

## 4. What Phase 1 changed

| Area | Change |
|---|---|
| `scripts/build-web.js` (new) | Whitelist copy of the frontend runtime into `www/`; secret-pattern guard fails the build on credential-like files; verifies app shell + camera + MediaPipe/WASM/model assets are present. |
| `www/` (generated, gitignored) | Native web bundle. Never hand-edited; source of truth stays the repo root. |
| `capacitor.config.json` (new) | `appId: com.example.lifeprogress` (**temporary — must be finalized before store preparation**), `webDir: www`, `androidScheme: https` (secure context for getUserMedia/WebCrypto). JSON, not `.ts`, to avoid adding a TypeScript toolchain to a zero-bundler project. |
| `ios/`, `android/` (new) | Capacitor 8 native shells. Version-controlled; generated build outputs and the copied `public/`/`assets/public` bundles are gitignored. |
| `js/platform.js` (new) | The web/native boundary: `isNative()`, `getPlatform()` (`'web'|'ios'|'android'`), `platformInfo()`. Detects Capacitor's real injected bridge (`window.Capacitor.isNativePlatform()` / `getPlatform()`), validates its shape, and degrades to `'web'` on any absence/malformation/throw. No user-agent sniffing. |
| `js/app.js` (minimal edit) | Two explicit gates: native shells skip service-worker registration and Web Push re-sync. Web behavior is untouched. Documented as the temporary boundary until native push lands. |
| `sw.js` (minimal edit) | `js/platform.js` added to precache; cache bumped `life-progress-v1.14` → `v1.15` so the updated shell propagates. SW logic unchanged. |
| `package.json` | Capacitor 8.5.2 as devDependencies only; scripts `build:web`, `cap:sync`, `cap:open:ios`, `cap:open:android`; `test/platform.test.js` registered. Runtime code keeps zero dependencies. |
| `.gitignore` | `/www/`, Apple credentials (`*.p8`, `*.pem`, provisioning), Xcode/Gradle build output, Firebase credential files (`google-services.json`, `GoogleService-Info.plist`, service-account JSON), `.env*`. The `ios/` and `android/` projects themselves stay versioned per Capacitor's repo guidance. |

## 5. What intentionally did NOT change

- All notification semantics, Web Push flow, VAPID handling, dedup, quiet
  hours, timezone math (`js/timeCore.js`, `server/push/domain.js`).
- Cloudflare Worker, Durable Object, scheduler, alarm trigger, schema.
- `js/db.js` (IndexedDB `life-progress-db` V5), export/import, wipe.
- Camera/pose code (`js/camera/*`, `js/pose/*`, `vendor/mediapipe/*`).
- GitHub Pages deployment, PWA manifest, `push-config.js`.
- All 20 pre-existing test files.

## 6. Intentionally deferred (later phases)

- APNs provider + iOS push registration; FCM provider + Android push
  registration (backend dispatcher, `push_subscriptions` platform/token
  migration, native push plugin, deep-link bridging, diagnostics updates).
- No Apple/Firebase credentials, no push entitlements, no bundle-ID
  finalization in this phase.

## 7. iOS PWA limitation — still true for the PWA

The documented PWA/WebKit limitation stands: on iOS, when the Home Screen
web app is **force-quit or swiped away** from the app switcher, background
Web Push delivery stops (no live process for webpushd to wake; WebKit bug
258254). Backgrounded-but-alive and locked-screen delivery keep working.
`js/pushClient.js#iosLifecycleBlocker` continues to surface this honestly.

**Phase 1 does not solve notifications.** The native iOS application is
intended to receive reminders through APNs in a later phase, which removes
that dependency on a live web-app process.

## 8. WebView storage caveat (documented, accepted)

The native apps keep the existing local-first storage: the same IndexedDB
(`life-progress-db` V5) inside the WebView, same export/import, same wipe.
No second database, no cloud sync, no data migration. Known caveat: WebKit
may evict WKWebView website data under device storage pressure; the
existing export/import is the user-level mitigation. Revisit if native
file-backed storage is ever added — deliberately not in Phase 1.

## 9. Native build workflow

```
npm run build:web     # repo-root web app → www/ (whitelist + guards)
npx cap sync          # www/ → ios/App/App/public + android assets
npm run cap:open:ios  # Xcode
npm run cap:open:android  # Android Studio
```
