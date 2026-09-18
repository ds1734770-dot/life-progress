# Native App Migration — Architecture & Decision Record

**Status:** Phase 3 complete (Capacitor scaffolding → multi-platform dispatcher + DO schema → iOS APNs provider + native client). FCM/Android is **not** implemented yet.
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

## 10. Phase 2 — multi-platform delivery foundation (complete)

- `server/push/dispatch.js`: `dispatchNotification(device, payload, deps)` —
  the single seam between the scheduler and platform providers.
  `resolveProvider()`: `web`→Web Push, `ios`→APNs, `android`→FCM,
  unknown→null (registration rejected). Providers return typed outcomes:
  `delivered | gone | transient_failure | permanent_failure | not_configured`.
  Provider throws are caught → transient; a tick can never crash.
- `server/push/http.js`: platform-aware validation. Legacy bodies (no
  `platform`) validate byte-identically → `web`. Native bodies require a
  `token` and no Web Push fields; unknown platforms are rejected, never coerced.
- `cloudflare/do.js`: additive, idempotent `migrateSchema()` — `PRAGMA
  table_info` detection → `ALTER TABLE ADD COLUMN platform TEXT NOT NULL
  DEFAULT 'web'` / `token TEXT` (try-ALTER fallback if PRAGMA is ever
  unavailable). No table rebuild; existing rows become `platform='web',
  token=NULL` and keep delivering without re-registration.
- `server/scheduler.js` / `server/api.js`: same dispatcher, same typed
  outcomes; legacy result shape preserved so retry bookkeeping is untouched.
- Web Push crypto (`server/push/webpush.js` — RFC 8291/8188/8292) and
  `server/push/domain.js` remain byte-identical.

## 11. Phase 3 — iOS APNs native delivery (complete in code; device testing pending)

### Delivery path

```
DO alarm → occurrence → dispatchNotification
  → resolveProvider('ios') → server/push/apns.js
  → ES256 JWT (token auth) → HTTP/2 api.push.apple.com
  → apns-topic = bundle ID → alert push, priority 10
  → typed outcome → existing occurrence bookkeeping
```

### APNs provider (`server/push/apns.js`)

- **Token-based auth only** — ES256 JWT signed with the Apple `.p8` key on
  raw WebCrypto: header `{alg:'ES256', kid:APNS_KEY_ID}`, claims
  `{iss:APNS_TEAM_ID, iat:now}`. No certificates. Node adapters reuse the
  same WebCrypto path (Node ≥ 16 `crypto.subtle`), so JWT logic is shared.
- **Payload transform**: the dispatcher hands providers the shared minimal
  payload (`buildPushPayload`); the provider wraps it for APNs — `aps`
  alert copy comes from the SAME copy table as the service worker
  (`js/swPush.js`), so wording stays in sync; `route` goes into `userInfo`
  for tap deep links. No private user data added.
- **Response mapping**: 200→delivered · 400 BadDeviceToken / 410
  Unregistered→gone · 429/5xx→transient · other 4xx→permanent ·
  network throw→transient · missing/invalid config→not_configured.
  Native devices are never sent through Web Push.
- **Runtime handling**: APNs requires HTTP/2. Workers' global `fetch`
  negotiates HTTP/2 and is the provider's default transport; Node's global
  fetch speaks HTTP/1.1, so `server/push/nodeHttp2.js` adapts `node:http2`
  to the same transport contract. One provider, two runtimes, no duplicated
  business logic.

### iOS client (`js/nativePush.js`, Capacitor 8 + @capacitor/push-notifications)

- Gated on `js/platform.js`; **inert on web** (test-verified).
- Flow: checkNotifications → requestPermissions → addListener('registration')
  → `POST /api/push/register` with `platform:'ios'`, `token`, existing
  preferences schema (no endpoint/p256dh/auth) → token refresh via the
  `'registrationError'`+re-register path updates the SAME deviceKey row.
- Taps: `addListener('pushNotificationActionPerformed')` → `userInfo.route`
  → existing hash routes (`#/water`, `#/gym`, …), allowlisted; cold start
  handled (late listener registration), no duplicate navigation.
- Foreground: notifications are presented while the app is open (Capacitor
  foreground presentation), consistent with existing copy semantics.
- Listeners are tracked and cleaned up; a hardened tap handler can never
  throw during teardown.

### Diagnostics & settings (`js/screens/notificationsSettings.js`)

Native iOS shows honest APNs states (native-available, permission
not-requested/denied, token-unavailable, backend-pending/registered,
backend-not-configured). The old web-only PWA message about iOS pausing
delivery when swiped away is NOT shown in native mode. Web/PWA keeps the
existing Web Push UI unchanged.

### Honest status

- **No real-device APNs delivery has been verified.** Force-quit/swiped-away
  behavior can only be claimed solved after the physical iPhone matrix
  (spec §28) is executed. Xcode build/device run requires a dev machine.

## 12. Manual Apple Developer prerequisites (NOT configured)

Everything below is pending; nothing has been enrolled, created, or uploaded:

1. **Apple Developer Program** membership ($99/yr).
2. **App ID / Bundle ID** — replace temporary `com.example.lifeprogress`
   (in `capacitor.config.json` + `ios/App/App.xcodeproj/project.pbxproj`) with
   the final ID, then `npx cap sync ios`.
3. **Push Notifications capability** on the App ID; add
   `aps-environment` entitlement (development first, then production) and
   `UIBackgroundModes: [remote-notifications]` in `Info.plist` if remote
   background wake is later needed — alert pushes over APNs do not require it.
4. **APNs Auth Key (.p8)** — create in the Apple Developer portal (one key
   covers sandbox + production). Record the **Key ID** and **Team ID**.
5. **Secrets** (never committed): set via `wrangler secret put` on the
   Worker — `APNS_KEY_P8` (PEM), `APNS_KEY_ID`, `APNS_TEAM_ID`,
   `APNS_BUNDLE_ID`, and `APNS_ENV=sandbox|production`. The provider reads
   only env config and returns honest `not_configured` when unset — safe to
   deploy before secrets exist.
6. **Physical iPhone test matrix** — install via Xcode/TestFlight; verify
   app open / background / locked / swiped away / force-quit / reboot /
   permission denied-then-granted / tap deep link / quiet hours /
   duplicates / timezone. Document results here.
7. **Key rotation/revocation** — revoke in the portal, replace secrets,
   restart; tokens remain valid (they're device-side). Old JWTs die with
   the key because provider tokens are minted per-send.
8. Later: privacy disclosure, icons/splash, App Store metadata.

FCM/Android remains untouched (`not_configured`) until its own phase.
